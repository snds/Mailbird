// End-to-end check of the relay: two clients merge, a wrong token is
// refused, unknown document names are refused, documents survive a
// restart, and shared notes (ADR-0056) open with their link's token, only
// while shared, read-only when view-only, and close when revoked. Runs the
// real server on a spare port with a temp data folder.

import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HocuspocusProvider } from "@hocuspocus/provider"
import * as Y from "yjs"

const PORT = 41234
const TOKEN = "relay-test-token-0123456789"
const data = await mkdtemp(join(tmpdir(), "notes-relay-"))

function start() {
  const p = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, NOTES_RELAY_TOKEN: TOKEN, NOTES_RELAY_PORT: String(PORT), NOTES_RELAY_DATA: data }, stdio: ["ignore", "pipe", "inherit"] })
  return new Promise((resolve) => p.stdout.on("data", (d) => String(d).includes("Notes relay on") && resolve(p)))
}
const stop = (p) => new Promise((r) => (p.once("exit", r), p.kill()))

function connect(name, token = TOKEN) {
  const doc = new Y.Doc()
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${PORT}`,
      name,
      document: doc,
      token,
      onSynced: () => resolve({ doc, provider }),
      onAuthenticationFailed: () => reject(new Error("refused")),
    })
    setTimeout(() => reject(new Error("timeout")), 5000)
  })
}
// What the owner's devices put in a share's link (ADR-0056).
const shareToken = (id) => `s1.${createHmac("sha256", TOKEN).update(`share:${id}`).digest("base64url")}`
const closed = (provider) => new Promise((resolve) => provider.on("close", () => resolve(true)))

const until = async (check) => {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail("timed out waiting")
}

let server = await start()
try {
  const a = await connect("mailbird/note/n1")
  const b = await connect("mailbird/note/n1")
  a.doc.getText("t").insert(0, "hello")
  await until(() => b.doc.getText("t").toString() === "hello")
  // Concurrent edits from both sides both survive.
  a.doc.getText("t").insert(0, "A:")
  b.doc.getText("t").insert(b.doc.getText("t").length, ":B")
  await until(() => a.doc.getText("t").toString() === "A:hello:B" && b.doc.getText("t").toString() === "A:hello:B")
  console.log("ok two clients merge")

  await assert.rejects(connect("mailbird/note/n1", "wrong-token-000000000"), /refused/)
  console.log("ok wrong token refused")
  await assert.rejects(connect("other/doc"), /refused/)
  console.log("ok unknown document refused")

  // Shared notes: the owner lists the share in the index, a guest opens it with the link's token.
  const SHARE = "s0meShareId_0123456789"
  const index = await connect("mailbird/index")
  const owner = await connect(`mailbird/shared/${SHARE}`)
  await assert.rejects(connect(`mailbird/shared/${SHARE}`, shareToken(SHARE)), /refused/)
  console.log("ok a share the owner hasn't listed is refused")
  index.doc.getMap("shares").set(SHARE, { note: "n2", mode: "edit", revoked: false, updated: 1 })
  await new Promise((r) => setTimeout(r, 200))
  const guest = await connect(`mailbird/shared/${SHARE}`, shareToken(SHARE))
  owner.doc.getText("t").insert(0, "milk")
  await until(() => guest.doc.getText("t").toString() === "milk")
  guest.doc.getText("t").insert(4, ", eggs")
  await until(() => owner.doc.getText("t").toString() === "milk, eggs")
  console.log("ok a guest with the link edits the shared note live")
  await assert.rejects(connect("mailbird/index", shareToken(SHARE)), /refused/)
  await assert.rejects(connect("mailbird/note/n1", shareToken(SHARE)), /refused/)
  await assert.rejects(connect("mailbird/shared/an0therShareId_0123456", shareToken(SHARE)), /refused/)
  console.log("ok the link's token opens that note and nothing else")

  // A shared conversation (ADR-0060) is the same kind of share: a teammate comments live, and stopping drops them.
  const THREAD = "t3amThreadId_0123456789"
  index.doc.getMap("shares").set(THREAD, { thread: "thread-1", mode: "edit", revoked: false, updated: 1 })
  await new Promise((r) => setTimeout(r, 200))
  const owned = await connect(`mailbird/shared/${THREAD}`)
  const mate = await connect(`mailbird/shared/${THREAD}`, shareToken(THREAD))
  // Its files sit beside it (ADR-0061): the same link opens them, and nothing else's.
  const ownedFiles = await connect(`mailbird/shared/${THREAD}/files`)
  const mateFiles = await connect(`mailbird/shared/${THREAD}/files`, shareToken(THREAD))
  ownedFiles.doc.getMap("attachments").set("a1", { name: "plan.pdf", data: "AAA=" })
  await until(() => mateFiles.doc.getMap("attachments").get("a1")?.name === "plan.pdf")
  await assert.rejects(connect(`mailbird/shared/${SHARE}/files`, shareToken(THREAD)), /refused/)
  console.log("ok a share's files open with its link, and only its own")
  mate.doc.getArray("comments").push([{ id: "c1", author: "Ana", at: 1, text: "Let's say yes" }])
  await until(() => owned.doc.getArray("comments").length === 1)
  const left = Promise.race([closed(mate.provider), new Promise((r) => setTimeout(() => r(false), 3000))])
  const leftFiles = Promise.race([closed(mateFiles.provider), new Promise((r) => setTimeout(() => r(false), 3000))])
  index.doc.getMap("shares").set(THREAD, { thread: "thread-1", mode: "edit", revoked: true, updated: 2 })
  assert.equal(await left, true, "a teammate is dropped when the conversation stops being shared")
  assert.equal(await leftFiles, true, "and from its files")
  ownedFiles.provider.destroy()
  await assert.rejects(connect(`mailbird/shared/${THREAD}`, shareToken(THREAD)), /refused/)
  owned.provider.destroy()
  console.log("ok a shared conversation works like a shared note: live, then stopped")

  // View-only: a guest who could edit is dropped (to reconnect as a reader), and a viewer's edits don't reach anyone.
  const demoted = Promise.race([closed(guest.provider), new Promise((r) => setTimeout(() => r(false), 3000))])
  index.doc.getMap("shares").set(SHARE, { note: "n2", mode: "view", revoked: false, updated: 2 })
  assert.equal(await demoted, true, "an editing guest is dropped when the link turns view-only")
  await new Promise((r) => setTimeout(r, 200))
  const viewer = await connect(`mailbird/shared/${SHARE}`, shareToken(SHARE))
  assert.equal(viewer.doc.getText("t").toString(), "milk, eggs")
  viewer.doc.getText("t").insert(0, "VANDAL ")
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(owner.doc.getText("t").toString(), "milk, eggs")
  console.log("ok a view-only guest can read but not change it")

  // Revoked: connected guests are dropped, and the link stops working.
  const dropped = Promise.race([closed(viewer.provider), new Promise((r) => setTimeout(() => r(false), 3000))])
  index.doc.getMap("shares").set(SHARE, { note: "n2", mode: "view", revoked: true, updated: 3 })
  assert.equal(await dropped, true, "a connected guest is dropped")
  viewer.provider.destroy()
  guest.provider.destroy()
  await assert.rejects(connect(`mailbird/shared/${SHARE}`, shareToken(SHARE)), /refused/)
  owner.doc.getText("t").insert(0, "still mine: ")
  await until(() => owner.doc.getText("t").toString().startsWith("still mine: "))
  console.log("ok revoking drops guests and refuses the link; the owner keeps working")
  owner.provider.destroy()
  index.provider.destroy()

  // A link opened in a browser gets a page that explains it.
  const page = await fetch(`http://127.0.0.1:${PORT}/share#v1.abc`).then((r) => r.text())
  assert.match(page, /Open a shared note/)
  assert.match(page, /Open a link/)
  console.log("ok a share link in a browser explains itself")

  // Let the debounced save run, then restart and read it back.
  await new Promise((r) => setTimeout(r, 1500))
  a.provider.destroy()
  b.provider.destroy()
  await stop(server)
  server = await start()
  const c = await connect("mailbird/note/n1")
  assert.equal(c.doc.getText("t").toString(), "A:hello:B")
  c.provider.destroy()
  console.log("ok documents survive a restart")
} finally {
  await stop(server)
  await rm(data, { recursive: true, force: true })
}
process.exit(0)
