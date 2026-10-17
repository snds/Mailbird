// Raw <button> ratchet (ADR-0057). The dsa scan counts misuse of @unicron/ui
// components, but a plain <button> bypasses the system entirely, so it never
// shows up there. This counts them per file against .dsa/raw-buttons.json and
// fails when a file gains one. The baseline says why each file keeps its own:
// most are whole-surface hit areas (calendar cells, cards, rows) that no
// library control covers; the rest wait on a library addition it names.
//
//   node tools/ds-raw-buttons.mjs            # check
//   node tools/ds-raw-buttons.mjs --update   # accept the current counts

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = new URL("..", import.meta.url).pathname
const src = join(root, "apps/web/src")
const baselinePath = join(root, ".dsa/raw-buttons.json")

function* tsx(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* tsx(p)
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx") && !p.endsWith(".stories.tsx")) yield p
  }
}

const counts = {}
for (const f of tsx(src)) {
  // `render={<button />}` hands a library control its element: that's the system, not a bypass.
  const n = (readFileSync(f, "utf8").match(/(?<!render=\{)<button[\s>]/g) ?? []).length
  if (n) counts[relative(root, f)] = n
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)

let baseline = { total: 0, files: {} }
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
} catch {
  // No baseline yet: --update writes one.
}

if (process.argv.includes("--update")) {
  const files = {}
  for (const [f, n] of Object.entries(counts).sort()) files[f] = { count: n, why: baseline.files[f]?.why ?? "" }
  writeFileSync(baselinePath, `${JSON.stringify({ total, files }, null, 2)}\n`)
  console.log(`raw buttons: ${total} in ${Object.keys(files).length} files, baseline written`)
  process.exit(0)
}

const grew = Object.entries(counts).filter(([f, n]) => n > (baseline.files[f]?.count ?? 0))
console.log(`raw buttons: ${total} (baseline ${baseline.total})`)
if (grew.length) {
  for (const [f, n] of grew) console.log(`  grew: ${f} ${baseline.files[f]?.count ?? 0} → ${n}`)
  console.log('Use a @unicron/ui control (Button, IconButton, Item render={<button />}), or, for a whole-surface hit area, run "pnpm ds:raw-buttons --update" and say why in .dsa/raw-buttons.json.')
  process.exit(1)
}
if (total < baseline.total) console.log('Fewer than the baseline: run "pnpm ds:raw-buttons --update" to lock it in.')
