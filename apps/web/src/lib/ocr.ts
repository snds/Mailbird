import type { Worker } from "tesseract.js"

/**
 * Reading the text in an image, on this device (ADR-0045). Tesseract runs
 * in a worker, loaded from this app's own `ocr/` files the first time it's
 * needed: about 7 MB once, then cached by the browser. Images never leave
 * the device to be read.
 */

/** Words Tesseract is less sure of than this are left out: a photo's texture reads as noise otherwise. */
const MIN_WORD_CONFIDENCE = 60

let worker: Promise<Worker> | null = null
let queue: Promise<unknown> = Promise.resolve()

function start(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker, OEM } = await import("tesseract.js")
    const base = new URL("ocr/", document.baseURI).href
    return createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      // A folder: Tesseract picks the fastest engine this browser runs.
      corePath: base,
      langPath: base.replace(/\/$/, ""),
      // A same-origin worker, not a blob: one the content security policy would refuse.
      workerBlobURL: false,
    })
  })().catch((e: unknown) => {
    worker = null
    throw e
  })
  return worker
}

/** The text in an image, line by line; "" when there's none worth keeping. One image at a time. */
export function readText(image: Blob): Promise<string> {
  const job = queue.then(async () => {
    const w = await start()
    const { data } = await w.recognize(image, {}, { text: true, blocks: true })
    const lines: string[] = []
    for (const block of data.blocks ?? [])
      for (const p of block.paragraphs)
        for (const line of p.lines) {
          const words = line.words.filter((w) => w.confidence >= MIN_WORD_CONFIDENCE && /[\p{L}\p{N}]/u.test(w.text)).map((w) => w.text)
          if (words.length) lines.push(words.join(" "))
        }
    // A lone short "word" is almost always a misread smudge.
    const text = lines.join("\n").trim()
    return text.replace(/\s/g, "").length < 3 ? "" : text
  })
  queue = job.catch(() => undefined)
  return job
}
