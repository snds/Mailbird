// A small, self-hostable relay for Mailbird notes (ADR-0012).
//
// It is a plain Hocuspocus server: devices connect over WebSocket, merge
// each note's Yjs document, and get each other's edits live. Documents are
// kept as Yjs state files in NOTES_RELAY_DATA, so a device that was offline
// catches up later. One token per relay; every device uses the same one.
//
//   NOTES_RELAY_TOKEN=… node server.mjs
//
// Put it behind TLS (Caddy, nginx, a tunnel): devices only connect over
// wss://, except to localhost. The relay can read notes; it is not
// end-to-end encrypted.

import { randomBytes, timingSafeEqual } from "node:crypto"
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

// Only Mailbird's own document names: "mailbird/index", "mailbird/note/<id>", and
// "mailbird/file/<id>" (an image in a note, ADR-0044).
const NAME = /^mailbird\/(index|(note|file)\/[A-Za-z0-9-]{1,64})$/
const file = (name) => join(data, `${name.replaceAll("/", "__")}.ydoc`)

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
  async onAuthenticate({ token: given, documentName }) {
    if (!NAME.test(documentName)) throw new Error("unknown document")
    if (!same(given ?? "", token)) throw new Error("wrong token")
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

await server.listen()
console.log(`Notes relay on ws://${address}:${port} · data in ${data}`)
