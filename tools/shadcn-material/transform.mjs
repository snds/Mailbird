#!/usr/bin/env node
// Converts shadcn registry sources (Base UI base + a style file such as Nova)
// into project components that use Material Symbols instead of Lucide.
//
// Why this exists: the shadcn CLI only offers lucide/tabler/hugeicons/phosphor/
// remixicon, and it fetches pre-transformed code from ui.shadcn.com. This script
// does the same transform locally, from a checkout of github.com/shadcn-ui/ui,
// so the output is reproducible and reviewable.
//
// Usage:
//   node tools/shadcn-material/transform.mjs [--alias-mode app|package] <shadcn-checkout> <out-dir> [component ...]
//   (style defaults to nova; override with SHADCN_STYLE=vega etc.)
//
// --alias-mode app (the default) writes an app's `@/…` alias imports, as
// Mailbird had them. --alias-mode package writes package-relative imports for
// a component library laid out as src/components/ui/*.tsx, src/components/icon.tsx,
// src/lib/*, src/hooks/* (unicron's @unicron/ui), so the library can vendor
// this tool instead of rewriting its output by hand.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let aliasMode = "app"
const at = args.findIndex((a) => a === "--alias-mode" || a.startsWith("--alias-mode="))
if (at >= 0) {
  const inline = args[at].split("=")[1]
  aliasMode = inline ?? args[at + 1]
  args.splice(at, inline === undefined ? 2 : 1)
}
const [checkout, outDir, ...requested] = args
if (!checkout || !outDir || !["app", "package"].includes(aliasMode)) {
  console.error("usage: transform.mjs [--alias-mode app|package] <shadcn-checkout> <out-dir> [component ...]")
  process.exit(1)
}

// Where each kind of import points, from a file in components/ui/.
const ALIASES = {
  app: { utils: "@/lib/utils", ui: "@/components/ui/", hooks: "@/hooks/", lib: "@/lib/", icon: "@/components/icon" },
  package: { utils: "../../lib/utils", ui: "./", hooks: "../../hooks/", lib: "../../lib/", icon: "../icon" },
}[aliasMode]

const style = process.env.SHADCN_STYLE ?? "nova"
const registry = path.join(checkout, "apps/v4/registry")
const uiDir = path.join(registry, "bases/base/ui")
const iconMap = JSON.parse(fs.readFileSync(path.join(here, "icon-map.json"), "utf8"))

// 1. Style file → { "cn-button-variant-default": "bg-primary ..." }
const css = fs.readFileSync(path.join(registry, `styles/style-${style}.css`), "utf8")
const styleMap = new Map()
for (const m of css.matchAll(/\.(cn-[\w-]+)\s*\{\s*@apply\s+([^;]+);\s*\}/g)) {
  styleMap.set(m[1], m[2].trim().replace(/\s+/g, " "))
}

// Every Material Symbol the transform emits, so the font can be subset later.
const usedIcons = new Set()
const unresolved = new Set()

function inlineStyleTokens(src) {
  // Only touch string literals so identifiers are never rewritten.
  return src.replace(/(["'`])((?:(?!\1)[^\\]|\\.)*?)\1/g, (whole, q, body) => {
    if (!/\bcn-[\w-]+/.test(body)) return whole
    const replaced = body
      .split(/(\s+)/)
      .map((tok) => {
        if (!/^cn-[\w-]+$/.test(tok)) return tok
        if (styleMap.has(tok)) return styleMap.get(tok)
        unresolved.add(tok)
        return "" // Marker classes with no style rules are dropped, as the registry does.
      })
      .join("")
      .replace(/\s{2,}/g, " ")
      .trim()
    return q + replaced + q
  })
}

function swapIcons(src, file) {
  let touched = false
  const out = src.replace(/<IconPlaceholder\b([\s\S]*?)\/>/g, (_, attrs) => {
    const lucide = attrs.match(/lucide="([^"]+)"/)?.[1]
    const name = iconMap[lucide]
    if (!name) throw new Error(`${file}: no Material Symbol mapped for lucide "${lucide}" (edit icon-map.json)`)
    usedIcons.add(name)
    touched = true
    const rest = attrs
      .replace(/\s*(lucide|tabler|hugeicons|phosphor|remixicon)="[^"]*"/g, "")
      .trim()
    // name goes last so a spread of svg props (which can carry `name`) can't override it.
    return `<Icon${rest ? " " + rest : ""} name="${name}" />`
  })
  if (!touched) return out
  // Components that are just an icon (Spinner) type their props as svg props;
  // Icon's axis props (fill: boolean) replace svg's string `fill`.
  const iconOnly = out.includes('React.ComponentProps<"svg">')
  return out
    .replaceAll('React.ComponentProps<"svg">', 'Omit<IconProps, "name">')
    .replace(
      /import \{ IconPlaceholder \} from "[^"]+"\n/,
      iconOnly
        ? `import { Icon, type IconProps } from "${ALIASES.icon}"\n`
        : `import { Icon } from "${ALIASES.icon}"\n`
    )
}

function rewriteImports(src) {
  return src
    .replace(/from "cn"/g, `from "${ALIASES.utils}"`)
    .replace(/@\/registry\/bases\/base\/ui\//g, ALIASES.ui)
    .replace(/@\/registry\/bases\/base\/hooks\//g, ALIASES.hooks)
    .replace(/@\/registry\/bases\/base\/lib\//g, ALIASES.lib)
}

const files = requested.length
  ? requested.map((n) => `${n}.tsx`)
  : fs.readdirSync(uiDir).filter((f) => f.endsWith(".tsx"))

fs.mkdirSync(outDir, { recursive: true })
for (const file of files) {
  let src = fs.readFileSync(path.join(uiDir, file), "utf8")
  src = swapIcons(src, file)
  src = inlineStyleTokens(src)
  src = rewriteImports(src)
  // Icon swaps can leave the React namespace import unused (noUnusedLocals).
  if (!/\bReact\./.test(src.replace(/import \* as React from "react"\n/, ""))) {
    src = src.replace(/import \* as React from "react"\n/, "")
  }
  const header =
    aliasMode === "package"
      ? `// Generated from shadcn/ui (MIT) by the shadcn-material transform (base: Base UI, style: ${style}). See README → Regenerating components.\n// Edit freely — this is owned source, like any shadcn component.\n`
      : `// Generated by tools/shadcn-material from shadcn/ui (MIT), base: Base UI, style: ${style}.\n// Edit freely — this is owned source, like any shadcn component.\n`
  fs.writeFileSync(path.join(outDir, file), header + src)
  console.log(`✓ ${file}`)
}

const manifest = path.join(outDir, ".material-symbols.json")
const previous = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : []
fs.writeFileSync(manifest, JSON.stringify([...new Set([...previous, ...usedIcons])].sort(), null, 2) + "\n")
if (unresolved.size) console.log(`dropped marker classes: ${[...unresolved].sort().join(", ")}`)
