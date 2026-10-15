/**
 * Scanning a page from a photo (ADR-0045): find the page, straighten it, and
 * clean it up so it reads like a scan. Plain canvas math, on the device.
 */

/** A point as a share of the photo's width and height, 0 to 1. */
export interface Pt {
  x: number
  y: number
}
/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt]

export type ScanLook = "document" | "gray" | "color"

export const FULL: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/** Large photos are read at this size at most: plenty for a 2048 px page. */
const SOURCE_SIDE = 3200
const DETECT_SIDE = 256

export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can open. Try JPEG or PNG.")
  })
  const scale = Math.min(1, SOURCE_SIDE / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement("canvas")
  c.width = Math.round(bitmap.width * scale)
  c.height = Math.round(bitmap.height * scale)
  c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height)
  bitmap.close()
  return c
}

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!

/**
 * Where the page is, guessed: the largest bright area (paper is lighter than
 * the desk under it), and its four extreme corners. The full photo when
 * there's no clear page, so a screenshot or a close-up stays whole.
 */
export function findPage(photo: HTMLCanvasElement): Quad {
  const scale = DETECT_SIDE / Math.max(photo.width, photo.height)
  const w = Math.max(1, Math.round(photo.width * scale))
  const h = Math.max(1, Math.round(photo.height * scale))
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const g = c.getContext("2d", { willReadFrequently: true })!
  g.drawImage(photo, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h).data
  const gray = new Uint8Array(w * h)
  const hist = new Array<number>(256).fill(0)
  for (let p = 0; p < w * h; p++) {
    const v = Math.round(luma(d, p * 4))
    gray[p] = v
    hist[v]!++
  }
  // Otsu: the threshold that best splits dark from light.
  const total = w * h
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]!
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!
    if (!wB || wB === total) continue
    sumB += i * hist[i]!
    const mB = sumB / wB
    const mF = (sum - sumB) / (total - wB)
    const between = wB * (total - wB) * (mB - mF) ** 2
    if (between > best) {
      best = between
      threshold = i
    }
  }
  // The largest bright region, by flood fill.
  const seen = new Uint8Array(total)
  let biggest: number[] = []
  for (let start = 0; start < total; start++) {
    if (seen[start] || gray[start]! <= threshold) continue
    const region: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      region.push(p)
      const x = p % w
      const y = (p - x) / w
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (!seen[q] && gray[q]! > threshold) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    if (region.length > biggest.length) biggest = region
  }
  const share = biggest.length / total
  if (share < 0.15 || share > 0.92) return FULL
  let tl = { s: Infinity, p: 0 }
  let br = { s: -Infinity, p: 0 }
  let tr = { s: -Infinity, p: 0 }
  let bl = { s: Infinity, p: 0 }
  for (const p of biggest) {
    const x = p % w
    const y = (p - x) / w
    if (x + y < tl.s) tl = { s: x + y, p }
    if (x + y > br.s) br = { s: x + y, p }
    if (x - y > tr.s) tr = { s: x - y, p }
    if (x - y < bl.s) bl = { s: x - y, p }
  }
  const pt = (p: number): Pt => ({ x: (p % w) / (w - 1 || 1), y: Math.floor(p / w) / (h - 1 || 1) })
  const quad: Quad = [pt(tl.p), pt(tr.p), pt(br.p), pt(bl.p)]
  // A hair inside the edge: at this coarse size, the edge pixels are half desk.
  const cx = quad.reduce((s, q) => s + q.x, 0) / 4
  const cy = quad.reduce((s, q) => s + q.y, 0) / 4
  return quad.map((q) => ({ x: q.x + (cx - q.x) * 0.012, y: q.y + (cy - q.y) * 0.012 })) as Quad
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** The unit square onto a quad (Heckbert): (u, v) in 0–1 to a source point. */
function squareToQuad([p0, p1, p2, p3]: Quad) {
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  let g = 0
  let h = 0
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / det
    h = (dx1 * dy3 - dx3 * dy1) / det
  }
  const a = p1.x - p0.x + g * p1.x
  const b = p3.x - p0.x + h * p3.x
  const d = p1.y - p0.y + g * p1.y
  const e = p3.y - p0.y + h * p3.y
  return (u: number, v: number): [number, number] => {
    const z = g * u + h * v + 1
    return [(a * u + b * v + p0.x) / z, (d * u + e * v + p0.y) / z]
  }
}

/**
 * The page inside `quad`, straightened to a rectangle no longer than `side`
 * on its long edge, with the chosen look.
 */
export function straighten(photo: HTMLCanvasElement, quad: Quad, side: number, look: ScanLook): HTMLCanvasElement {
  const W = photo.width
  const H = photo.height
  const px = quad.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) })) as Quad
  const ow = Math.max(dist(px[0], px[1]), dist(px[3], px[2]))
  const oh = Math.max(dist(px[0], px[3]), dist(px[1], px[2]))
  const scale = Math.min(1, side / Math.max(ow, oh))
  const w = Math.max(1, Math.round(ow * scale))
  const h = Math.max(1, Math.round(oh * scale))
  const src = photo.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, W, H).data
  const out = new ImageData(w, h)
  const o = out.data
  const map = squareToQuad(px)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = map((x + 0.5) / w, (y + 0.5) / h)
      // Bilinear: smooth edges where a pixel falls between four.
      const x0 = Math.min(W - 2, Math.max(0, Math.floor(sx)))
      const y0 = Math.min(H - 2, Math.max(0, Math.floor(sy)))
      const fx = Math.min(1, Math.max(0, sx - x0))
      const fy = Math.min(1, Math.max(0, sy - y0))
      const i00 = (y0 * W + x0) * 4
      const i10 = i00 + 4
      const i01 = i00 + W * 4
      const i11 = i01 + 4
      const j = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c]! * (1 - fx) + src[i10 + c]! * fx
        const bottom = src[i01 + c]! * (1 - fx) + src[i11 + c]! * fx
        o[j + c] = top * (1 - fy) + bottom * fy
      }
      o[j + 3] = 255
    }
  }
  if (look !== "color") toGray(out, look === "document")
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  c.getContext("2d")!.putImageData(out, 0, 0)
  return c
}

/**
 * Gray, or a clean document: each pixel divided by the paper's own
 * brightness around it (a blurred, shrunken copy), so shadows and uneven
 * light go white and the ink stays dark.
 */
function toGray(img: ImageData, clean: boolean) {
  const { width: w, height: h, data: d } = img
  const gray = new Float32Array(w * h)
  for (let p = 0; p < w * h; p++) gray[p] = luma(d, p * 4)
  let out = gray
  if (clean) {
    // The paper's brightness: the brightest of each 24 px cell, smoothed.
    const cell = 24
    const cw = Math.ceil(w / cell)
    const ch = Math.ceil(h / cell)
    const bg = new Float32Array(cw * ch)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = Math.floor(y / cell) * cw + Math.floor(x / cell)
      bg[k] = Math.max(bg[k]!, gray[y * w + x]!)
    }
    const smooth = new Float32Array(cw * ch)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy
        const xx = x + dx
        if (yy < 0 || xx < 0 || yy >= ch || xx >= cw) continue
        s += bg[yy * cw + xx]!
        n++
      }
      smooth[y * cw + x] = s / n
    }
    out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // Bilinear between cell centres.
      const gx = Math.min(cw - 1, Math.max(0, x / cell - 0.5))
      const gy = Math.min(ch - 1, Math.max(0, y / cell - 0.5))
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const x1 = Math.min(cw - 1, x0 + 1)
      const y1 = Math.min(ch - 1, y0 + 1)
      const fx = gx - x0
      const fy = gy - y0
      const b =
        (smooth[y0 * cw + x0]! * (1 - fx) + smooth[y0 * cw + x1]! * fx) * (1 - fy) + (smooth[y1 * cw + x0]! * (1 - fx) + smooth[y1 * cw + x1]! * fx) * fy
      const ratio = gray[y * w + x]! / Math.max(1, b)
      // Paper (ratio near 1) to white, ink (well below) to black, a soft ramp between.
      out[y * w + x] = 255 * Math.min(1, Math.max(0, (ratio - 0.55) / 0.35))
    }
  }
  for (let p = 0; p < w * h; p++) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = out[p]!
}

export const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("The scan couldn't be saved"))), "image/jpeg", 0.85))
