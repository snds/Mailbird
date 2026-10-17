// A small, self-hostable relay for Mailbird notes (ADR-0012).
//
// It is a plain Hocuspocus server: devices connect over WebSocket, merge
// each note's Yjs document, and get each other's edits live. Documents are
// kept as Yjs state files in NOTES_RELAY_DATA, so a device that was offline
// catches up later. One token per relay; every device uses the same one.
//
// Shared notes (ADR-0056): a note shared by link lives in its own document,
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
// wss://, except to localhost. The relay can read notes; it is not
// end-to-end encrypted.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
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
// "mailbird/shared/<id>" (a shared note, ADR-0056).
const NAME = /^mailbird\/(index|(note|file)\/[A-Za-z0-9-]{1,64}|shared\/[A-Za-z0-9_-]{16,64})$/
const SHARED = /^mailbird\/shared\/([A-Za-z0-9_-]{16,64})$/
const INDEX = "mailbird/index"
const file = (name) => join(data, `${name.replaceAll("/", "__")}.ydoc`)

/** The token a share's link carries: "s1." and the HMAC of its id. */
const shareToken = (relayToken, id) => `s1.${createHmac("sha256", relayToken).update(`share:${id}`).digest("base64url")}`

/** The owner's list of shares, from the index: live if it's open, else from disk. */
async function shares(instance) {
  const open = instance.documents.get(INDEX)
  if (open) return open.getMap("shares")
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, await readFile(file(INDEX)))
  } catch (e) {
    if (e.code !== "ENOENT") throw e
  }
  return doc.getMap("shares")
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
    if (same(given ?? "", token)) return { owner: true }
    // Not the relay token: only a shared note's own document, with its link's token.
    const id = SHARED.exec(documentName)?.[1]
    if (!id || !same(given ?? "", shareToken(token, id))) throw new Error("wrong token")
    const share = (await shares(instance)).get(id)
    if (!share || share.revoked) throw new Error("this note isn't shared any more")
    if (share.mode !== "edit") connectionConfig.readOnly = true
    return { share: id }
  },
  // The owner changed the list: guests of a revoked share leave now, and
  // guests who could edit a now view-only share reconnect as readers.
  async onChange({ documentName, document, instance }) {
    if (documentName !== INDEX) return
    for (const [id, share] of document.getMap("shares").entries()) {
      if (!share?.revoked && share?.mode === "edit") continue
      for (const c of instance.documents.get(`mailbird/shared/${id}`)?.getConnections() ?? []) {
        if (c.context?.share === id && (share?.revoked || !c.readOnly)) c.close()
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
  async onLoadDocument({ documentName, document }) {
    try {
      Y.applyUpdate(document, await readFile(file(documentName)))
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
    return document
  },
  async onStoreDocument({ documentName, document }) {
    // Write then rename, so a crash never leaves half a file.
    const target = file(documentName)
    await writeFile(`${target}.tmp`, Y.encodeStateAsUpdate(document))
    await rename(`${target}.tmp`, target)
  },
})

const SHARE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A shared note</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1a1c1f}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
<h1>Someone shared a note with you</h1>
<p>It opens in Mailbird. In Notes, choose <b>Open a shared note…</b> and paste this page's address. If the link came in a message in Mailbird, open it from there.</p>`

await server.listen()
console.log(`Notes relay on ws://${address}:${port} · data in ${data}`)
