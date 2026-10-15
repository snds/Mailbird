import { toBase64 } from "./base64"

/** The longest side a note image keeps: sharp on a 4K screen, a few hundred KB. */
export const IMAGE_SIDE = 2048
/** Small enough as they are: kept byte for byte (GIFs keep their animation). */
const KEEP_BYTES = 1_000_000
const KEPT = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])

export interface PreparedImage {
  mime: string
  dataBase64: string
  width: number
  height: number
}

/**
 * An image ready to store in a note (ADR-0044): photos are scaled to
 * {@link IMAGE_SIDE} and saved as JPEG; small images and GIFs stay as they
 * are. Throws, in words, when the browser can't read the file (HEIC on most
 * browsers, say).
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can open. Try saving it as JPEG or PNG.")
  })
  const { width, height } = bitmap
  try {
    const small = width <= IMAGE_SIDE && height <= IMAGE_SIDE && file.size <= KEEP_BYTES
    if (KEPT.has(file.type) && (small || file.type === "image/gif")) {
      return { mime: file.type, dataBase64: toBase64(new Uint8Array(await file.arrayBuffer())), width, height }
    }
    const scale = Math.min(1, IMAGE_SIDE / Math.max(width, height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const g = canvas.getContext("2d")!
    // JPEG has no transparency: a screenshot's clear areas become white, not black.
    g.fillStyle = "#fff"
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85))
    if (!blob) throw new Error("That image couldn't be prepared")
    return { mime: "image/jpeg", dataBase64: toBase64(new Uint8Array(await blob.arrayBuffer())), width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}
