import { createReadStream, readFileSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * The on-device text reader (Tesseract, ADR-0045), served from this app at
 * fixed names under `ocr/`, so it never loads from a CDN. Only the LSTM
 * engines (the ones its English data needs) ship. Nothing loads until a
 * note's image is read.
 */
const mod = (p: string) => path.resolve(__dirname, "node_modules", p)
const OCR_FILES: Record<string, string> = {
  "ocr/worker.min.js": mod("tesseract.js/dist/worker.min.js"),
  "ocr/tesseract-core-relaxedsimd-lstm.wasm.js": mod("tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js"),
  "ocr/tesseract-core-simd-lstm.wasm.js": mod("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"),
  "ocr/tesseract-core-lstm.wasm.js": mod("tesseract.js-core/tesseract-core-lstm.wasm.js"),
  "ocr/eng.traineddata.gz": mod("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
}

function ocrFiles(): Plugin {
  return {
    name: "mailbird-ocr-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = OCR_FILES[(req.url ?? "").split("?")[0]!.replace(/^\//, "")]
        if (!file) return next()
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "application/gzip")
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(OCR_FILES)) this.emitFile({ type: "asset", fileName, source: readFileSync(file) })
    },
  }
}

// Tauri expects a fixed port and must not clear its own console output.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss(), ocrFiles()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    // @unicron/ui links in from the workspace with its own dev copies of these:
    // one instance each, or hooks and Base UI's contexts break across the line.
    dedupe: ["react", "react-dom", "@base-ui/react"],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
})
