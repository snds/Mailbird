// A small, self-hostable relay for Mailbird notes (ADR-0012).
//
// It is a plain Hocuspocus server: devices connect over WebSocket, merge
// each note's Yjs document, and get each other's edits live. Documents are
// kept as Yjs state files in NOTES_RELAY_DATA, so a device that was offline
// catches up later. One token per relay; every device uses the same one.
//
// Shared notes (ADR-0056), and conversations shared with teammates (ADR-0060,
// same kind of link): a note shared by link lives in its own document,
// "mailbird/shared/<id>". Whoever holds the link gets a share token for
// that one document: an HMAC of its id under the relay token, so the relay
// keeps no list of tokens. The owner's devices keep the list of shares (and
// whether each is editable, or revoked) in the index, which only the relay
// token opens; the relay checks it on every connection, and drops a
// share's guests the moment it's revoked.
//
//   NOTES_RELAY_TOKEN=… node server.mjs
//
// Put it behind TLS (Caddy, nginx, a tunnel): devices only connect over
// wss://, except to localhost.
//
// End-to-end encryption (ADR-0062) is the owner's choice. Their devices then
// sync sealed documents, "mailbird/x/…", which the relay can't read: each is
// a log of encrypted Yjs updates, sent as Hocuspocus stateless messages and
// kept in a ".log" file. The list of shares moves to "mailbird/registry",
// which holds only what checking a link needs (an id, editable or not,
// stopped or not). Once a device turns it on, the relay drops every
// readable document it had and refuses new ones.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Server } from "@hocuspocus/server"
import * as Y from "yjs"

const token = process.env.NOTES_RELAY_TOKEN
if (!token || token.length < 16) {
  console.error(`Set NOTES_RELAY_TOKEN to a secret of 16+ characters, for example:\n  NOTES_RELAY_TOKEN=${randomBytes(24).toString("base64url")}`)
  process.exit(1)
}
const port = Number(process.env.NOTES_RELAY_PORT ?? 1234)
const address = process.env.NOTES_RELAY_ADDRESS ?? "127.0.0.1"
const data = process.env.NOTES_RELAY_DATA ?? join(process.cwd(), "data")
await mkdir(data, { recursive: true })

// Only Mailbird's own document names: "mailbird/index", "mailbird/note/<id>",
// "mailbird/file/<id>" (an image in a note, ADR-0044), and
// "mailbird/shared/<id>" (a shared note, ADR-0056); each sealed under
// "mailbird/x/" (ADR-0062); and "mailbird/registry".
const NAME = /^mailbird\/(registry|(x\/)?(index|(note|file)\/[A-Za-z0-9-]{1,64}|shared\/[A-Za-z0-9_-]{16,64}(\/files)?))$/
// A share's own document, and its files beside it (ADR-0061): one link opens both.
const SHARED = /^mailbird\/(?:x\/)?shared\/([A-Za-z0-9_-]{16,64})(?:\/files)?$/
const INDEX = "mailbird/index"
const REGISTRY = "mailbird/registry"
const sealed = (name) => name.startsWith("mailbird/x/")
const file = (name) => join(data, `${name.replaceAll("/", "__")}.ydoc`)
const logFile = (name) => join(data, `${name.replaceAll("/", "__")}.log`)
// Set once the owner turns on end-to-end encryption: readable documents are gone for good.
const SEALED_MARK = join(data, "SEALED")
let allSealed = await readFile(SEALED_MARK).then(() => true, () => false)
const SEALED_NOW = "This relay is end-to-end encrypted now. Add its encryption key under Sync between devices."

/** The token a share's link carries: "s1." and the HMAC of its id. */
const shareToken = (relayToken, id) => `s1.${createHmac("sha256", relayToken).update(`share:${id}`).digest("base64url")}`

/** One of the owner's lists of shares: live if it's open, else from disk. */
async function sharesIn(instance, name) {
  const open = instance.documents.get(name)
  if (open) return open.getMap("shares")
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, await readFile(file(name)))
  } catch (e) {
    if (e.code !== "ENOENT") throw e
  }
  return doc.getMap("shares")
}

/** A share as the owner listed it: in the registry once sealed, else in the index. */
async function shareOf(instance, id) {
  return (await sharesIn(instance, REGISTRY)).get(id) ?? (allSealed ? undefined : (await sharesIn(instance, INDEX)).get(id))
}

// ── Sealed documents (ADR-0062) ─────────────────────────────────────────────
// Each is a list of encrypted updates, oldest first. The relay only keeps
// and hands them out: it never sees a key, and can't tell what's in them.

const logs = new Map()
/** One document's log, read from disk once; changes run one at a time. */
function logOf(name) {
  let l = logs.get(name)
  if (!l) {
    l = { items: null, chain: Promise.resolve() }
    logs.set(name, l)
  }
  const run = (work) => {
    const next = l.chain.then(async () => {
      l.items ??= await readFile(logFile(name), "utf8").then(JSON.parse, (e) => (e.code === "ENOENT" ? [] : Promise.reject(e)))
      return work(l.items)
    })
    l.chain = next.catch(() => {})
    return next
  }
  const save = async (items) => {
    const target = logFile(name)
    await writeFile(`${target}.tmp`, JSON.stringify(items))
    await rename(`${target}.tmp`, target)
  }
  return { run, save }
}

/** Encrypted updates are base64; anything else isn't one. */
const SEALED_ITEM = /^[A-Za-z0-9+/]{24,}={0,2}$/

async function onSealed({ connection, documentName, document, payload }) {
  let m
  try {
    m = JSON.parse(payload)
  } catch {
    return
  }
  const log = logOf(documentName)
  const reply = (o) => connection.sendStateless(JSON.stringify(o))
  const others = (o) => document.broadcastStateless(JSON.stringify(o), (c) => c !== connection)
  switch (m?.t) {
    case "pull":
      return log.run((items) => reply({ t: "log", items }))
    case "push":
      if (connection.readOnly || typeof m.u !== "string" || !SEALED_ITEM.test(m.u)) return reply({ t: "no", id: m.id })
      return log.run(async (items) => {
        items.push(m.u)
        await log.save(items)
        reply({ t: "ok", id: m.id })
        others({ t: "u", u: m.u })
      })
    // A device that has read the first `upto` updates replaces them with one that holds them all.
    case "compact":
      if (connection.readOnly || typeof m.u !== "string" || !SEALED_ITEM.test(m.u) || !Number.isInteger(m.upto)) return
      return log.run(async (items) => {
        if (m.upto < 2 || m.upto > items.length) return
        items.splice(0, m.upto, m.u)
        await log.save(items)
      })
    // Who's here: passed on, never kept.
    case "p":
      if (typeof m.u === "string" && SEALED_ITEM.test(m.u)) others({ t: "p", u: m.u })
      return
    // The owner turned on end-to-end encryption: drop every readable document.
    case "purge":
      if (!connection.context?.owner || documentName !== "mailbird/x/index") return
      await purge(server.hocuspocus)
      return reply({ t: "purged" })
  }
}

async function purge(instance) {
  await writeFile(SEALED_MARK, `${new Date().toISOString()}\n`)
  allSealed = true
  for (const [name, doc] of instance.documents) {
    if (name === REGISTRY || sealed(name)) continue
    for (const c of doc.getConnections()) c.close()
  }
  for (const f of await readdir(data)) {
    if (f.endsWith(".ydoc") && !f.startsWith("mailbird__x__") && f !== "mailbird__registry.ydoc") await rm(join(data, f), { force: true })
  }
}

const same = (a, b) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const server = new Server({
  port,
  address,
  // Save at most once a second per document, and at least every 10 seconds while busy.
  debounce: 1000,
  maxDebounce: 10_000,
  quiet: true,
  async onAuthenticate({ token: given, documentName, instance, connectionConfig }) {
    if (!NAME.test(documentName)) throw new Error("unknown document")
    // With a reason, so a device without the key can say why.
    if (allSealed && documentName !== REGISTRY && !sealed(documentName)) throw Object.assign(new Error(SEALED_NOW), { reason: SEALED_NOW })
    if (same(given ?? "", token)) return { owner: true }
    // Not the relay token: only a shared note's own document, with its link's token.
    const id = SHARED.exec(documentName)?.[1]
    if (!id || !same(given ?? "", shareToken(token, id))) throw new Error("wrong token")
    const share = await shareOf(instance, id)
    if (!share || share.revoked) throw new Error("this isn't shared any more")
    if (share.mode !== "edit") connectionConfig.readOnly = true
    return { share: id }
  },
  // The owner changed the list: guests of a revoked share leave now, and
  // guests who could edit a now view-only share reconnect as readers.
  async onChange({ documentName, document, instance }) {
    if (documentName !== INDEX && documentName !== REGISTRY) return
    for (const [id, share] of document.getMap("shares").entries()) {
      if (!share?.revoked && share?.mode === "edit") continue
      for (const name of [`mailbird/shared/${id}`, `mailbird/shared/${id}/files`, `mailbird/x/shared/${id}`, `mailbird/x/shared/${id}/files`]) {
        for (const c of instance.documents.get(name)?.getConnections() ?? []) {
          if (c.context?.share === id && (share?.revoked || !c.readOnly)) c.close()
        }
      }
    }
  },
  // A share link opened in a browser lands here (the part after # never reaches the relay).
  async onRequest({ request, response }) {
    if (!request.url?.startsWith("/share")) return
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    response.end(SHARE_PAGE)
    throw null
  },
  async onStateless(payload) {
    if (sealed(payload.documentName)) await onSealed(payload)
  },
  // A sealed document's Yjs side is a placeholder: nothing in it is kept.
  async onLoadDocument({ documentName, document }) {
    if (sealed(documentName)) return document
    try {
      Y.applyUpdate(document, await readFile(file(documentName)))
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
    return document
  },
  async onStoreDocument({ documentName, document }) {
    if (sealed(documentName) || (allSealed && documentName !== REGISTRY)) return
    // Write then rename, so a crash never leaves half a file.
    const target = file(documentName)
    await writeFile(`${target}.tmp`, Y.encodeStateAsUpdate(document))
    await rename(`${target}.tmp`, target)
  },
})

const SHARE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared with you in Mailbird</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1a1c1f}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
<h1>Someone shared something with you</h1>
<p>It opens in Mailbird. A note: in Notes, choose <b>Open a shared note…</b> and paste this page's address. A conversation: in Mail, open <b>Team</b> and choose <b>Open a link…</b>. If the link came in a message in Mailbird, open it from there.</p>`

await server.listen()
console.log(`Notes relay on ws://${address}:${port} · data in ${data}`)
