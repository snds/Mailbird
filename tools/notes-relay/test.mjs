// End-to-end check of the relay: two clients merge, a wrong token is
// refused, unknown document names are refused, and documents survive a
// restart. Runs the real server on a spare port with a temp data folder.

import assert from "node:assert/strict"
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
