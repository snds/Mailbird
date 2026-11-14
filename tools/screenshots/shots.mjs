#!/usr/bin/env node
// Takes a picture of every main screen of the web app, on its sample data.
// See README.md beside this file. Run it from the repository root: `pnpm shots`.
import { spawnSync } from "node:child_process"
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { availableParallelism } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

import { scenes } from "./scenes.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "../..")
const dist = path.join(repo, "apps/web/dist")

/** Every picture is taken at this moment, in this place, so dates read the same on every run. */
const NOW = "2026-11-12T09:16:00"
const TIME_ZONE = "America/Los_Angeles"
const LOCALE = "en-US"

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  medium: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
}
/** A scene that lists no sizes has these. */
const DEFAULT_SIZES = ["desktop", "phone"]
const THEMES = ["light", "dark"]

/** The pictures for Sean (--sean): his names for the sizes and themes, at twice the pixel density. */
const SEAN = { sizes: ["phone", "desktop", "landscape"], themes: { light: "stone", dark: "graphite" }, kinds: ["drawn", "undrawn"], scale: 2 }
/** The demo client reads its scenario from here once, at start (apps/web/src/core/demo-scenarios.ts). */
const SCENARIO_KEY = "vale.demo.scenario"

/**
 * Motion is off while pictures are taken. A dialog that animates open keeps
 * icon pixels from part-way through, and they differ from run to run.
 */
const NO_MOTION = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; }"

function usage() {
  console.log(`usage: pnpm shots [--out <folder>] [-g <text>]… [--size <size>]… [--theme light|dark]
                  [--demo] [--sean] [--jobs <n>] [--no-build] [--list]

  --out <folder>   where the pictures go (default: tools/screenshots/out)
  -g <text>        only scenes whose name contains <text>; repeat it for several, e.g. -g mail-inbox -g calendar-week
  --size <size>    only that size: desktop (1440 × 900), phone (390 × 844, touch), medium (768 × 1024, touch)
                   or landscape (844 × 390, touch); repeat it for several. A scene runs only at sizes it has
  --theme          only light or dark
  --demo           build the desktop demo instead (VITE_DEMO_APP=1)
  --sean           only scenes with sean metadata, at 2×, named for Sean:
                   <folder>/<drawn|undrawn>/<area>--<screen>__<phone|desktop|landscape>__<graphite|stone>.png.
                   The folder is --out, else $SP/shots/built/vale
  --jobs <n>       pictures taken at once (default: 4, or the number of cores if lower)
  --no-build       use apps/web/dist as it is, without building first
  --list           print the scene names and stop

  VALE_SHOTS_CHROME=<path>  the browser to drive. Without it: Playwright's own Chromium
                            when it is installed, else the Chrome on this machine.`)
}

function parseArgs(argv) {
  const a = { out: null, grep: [], sizes: [], theme: null, jobs: Math.min(4, availableParallelism()), build: true, list: false, demo: false, sean: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`)
      return argv[++i]
    }
    // pnpm runs the script from the repository root; a relative folder means the one you typed it in.
    if (k === "--out") a.out = path.resolve(process.env.INIT_CWD ?? process.cwd(), value())
    else if (k === "-g" || k === "--grep") a.grep.push(value())
    else if (k === "--size") a.sizes.push(value())
    else if (k === "--theme") a.theme = value()
    else if (k === "--jobs") a.jobs = Math.max(1, Number(value()) || 1)
    else if (k === "--no-build") a.build = false
    else if (k === "--list") a.list = true
    else if (k === "--demo") a.demo = true
    else if (k === "--sean") a.sean = true
    else if (k === "-h" || k === "--help") {
      usage()
      process.exit(0)
    }
    else throw new Error(`unknown option ${k}`)
  }
  for (const s of a.sizes) if (!SIZES[s]) throw new Error(`--size is ${Object.keys(SIZES).join(", ")}, not ${s}`)
  if (a.theme && !THEMES.includes(a.theme)) throw new Error(`--theme is light or dark, not ${a.theme}`)
  if (!a.out && a.sean) {
    if (!process.env.SP) throw new Error("--sean needs a folder: --out <folder>, or SP=<scratch folder> for $SP/shots/built/vale")
    a.out = path.join(process.env.SP, "shots/built/vale")
  }
  a.out ??= path.join(here, "out")
  return a
}

/** Catches a mistake in a scene before any browser starts. */
function checkScenes(list) {
  const names = new Set()
  const seanNames = new Map()
  const OPTIONS = new Set(["name", "run", "path", "sizes", "viewport", "scenario", "offline", "loading", "assert", "sean", "demo"])
  for (const s of list) {
    if (typeof s.name !== "string" || !s.name) throw new Error(`a scene has no name: ${JSON.stringify(s)}`)
    if (names.has(s.name)) throw new Error(`two scenes are named ${s.name}`)
    names.add(s.name)
    if ("only" in s) throw new Error(`scene ${s.name}: "only" is now sizes: ["${s.only}"]`)
    for (const k of Object.keys(s)) if (!OPTIONS.has(k)) throw new Error(`scene ${s.name}: unknown option ${k}`)
    if (s.sizes && (!Array.isArray(s.sizes) || !s.sizes.length || s.sizes.some((z) => !SIZES[z]))) throw new Error(`scene ${s.name}: sizes are from ${Object.keys(SIZES).join(", ")}`)
    if (s.viewport && !(s.viewport.width > 0 && s.viewport.height > 0)) throw new Error(`scene ${s.name}: viewport is { width, height }`)
    if (s.assert && typeof s.assert !== "function") throw new Error(`scene ${s.name}: assert is a function of app`)
    for (const n of [s.scenario ?? []].flat()) if (typeof n !== "string" || !/^[a-z0-9-]+$/.test(n)) throw new Error(`scene ${s.name}: scenario names are like "sync-error", not ${JSON.stringify(n)}`)
    if (s.sean) {
      const { kind, area, screen } = s.sean
      if (!SEAN.kinds.includes(kind)) throw new Error(`scene ${s.name}: sean.kind is drawn or undrawn`)
      for (const [k, v] of [["area", area], ["screen", screen]]) if (typeof v !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) throw new Error(`scene ${s.name}: sean.${k} is lowercase words joined by "-"`)
      const key = `${kind}/${area}--${screen}`
      if (s.sean.sizes !== undefined && !(Array.isArray(s.sean.sizes) && s.sean.sizes.length && s.sean.sizes.every((z) => z in SIZES))) throw new Error(`scene ${s.name}: sean.sizes lists sizes (${Object.keys(SIZES).join(", ")})`)
      if (seanNames.has(key)) throw new Error(`scenes ${seanNames.get(key)} and ${s.name} both export ${key}`)
      seanNames.set(key, s.name)
    }
  }
}

/** The pictures one scene makes: each size it has (narrowed by --size), each theme. */
function jobsFor(scene, args) {
  let sizes = scene.sizes ?? DEFAULT_SIZES
  if (args.sizes.length) sizes = args.sizes.filter((z) => !scene.sizes || scene.sizes.includes(z))
  // Sean's set leaves medium out, unless the scene is of a medium-width screen and says so (`sean.sizes`).
  if (args.sean) sizes = sizes.filter((z) => (scene.sean.sizes ?? SEAN.sizes).includes(z))
  const themes = args.theme ? [args.theme] : THEMES
  return sizes.flatMap((size) => themes.map((theme) => ({ scene, size, theme })))
}

/** Where a picture goes, and its label in the log. */
function fileOf(job, args) {
  const { scene, size, theme } = job
  if (!args.sean) return path.join(args.out, `${scene.name}-${size}-${theme}.png`)
  const { kind, area, screen } = scene.sean
  return path.join(args.out, kind, `${area}--${screen}__${size}__${SEAN.themes[theme]}.png`)
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".gz": "application/gzip", ".txt": "text/plain; charset=utf-8",
}

/** Serves the built app from a free port on this machine only. Unknown paths get the app, as the gateway does. */
function serve() {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
    let file = path.join(dist, pathname)
    if (!file.startsWith(dist + path.sep) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html")
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })))
}

async function launch() {
  const own = process.env.VALE_SHOTS_CHROME
  if (own) return chromium.launch({ executablePath: own })
  if (existsSync(chromium.executablePath())) return chromium.launch()
  return chromium.launch({ channel: "chrome" })
}

/**
 * Waits until the screen has stopped changing: fonts in, nothing loading, no
 * transition still running, and no change to the page or to what has focus
 * for a moment. A screen that never gets there fails its picture. With
 * `loading`, the picture is of a loading screen, so skeletons and aria-busy
 * don't count as changing.
 */
async function settle(page, { loading = false } = {}) {
  const still = await page.evaluate(async (allowLoading) => {
    const QUIET_MS = 300
    const GIVE_UP_MS = 8000
    await document.fonts.ready
    const busy = () => !allowLoading && !!document.querySelector('[aria-busy="true"], [data-slot="skeleton"]')
    // Endless animations (a spinner) never finish, so only ones that end count as still moving.
    const moving = () => document.getAnimations().some((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    const result = await new Promise((resolve) => {
      const started = performance.now()
      let last = started
      const touch = () => (last = performance.now())
      const observer = new MutationObserver(touch)
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      document.addEventListener("focusin", touch, true)
      const done = (value) => {
        observer.disconnect()
        document.removeEventListener("focusin", touch, true)
        resolve(value)
      }
      const tick = () => {
        const now = performance.now()
        if (busy() || moving()) last = now
        if (now - last >= QUIET_MS) done(true)
        else if (now - started > GIVE_UP_MS) done(busy() ? "something is still loading" : moving() ? "something is still moving" : "the page keeps changing")
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await document.fonts.ready
    return result
  }, loading)
  if (still !== true) throw new Error(`the screen never settled: ${still}`)
}

async function shoot(browser, origin, job, file, scale) {
  const { scene, size, theme } = job
  const viewport = scene.viewport ?? SIZES[size].viewport
  const context = await browser.newContext({ ...SIZES[size], viewport, deviceScaleFactor: scale, colorScheme: theme, locale: LOCALE, timezoneId: TIME_ZONE })
  const problems = []
  try {
    // The app's own theme choice, where it keeps one (next-themes), follows the picture's theme.
    // A scene's demo scenario is in place before the app's first line runs.
    await context.addInitScript(([t, key, scenario]) => {
      try {
        localStorage.setItem("theme", t)
        if (scenario) sessionStorage.setItem(key, scenario)
      } catch {
        // No storage: the browser's color scheme still decides, and a scenario can't be set.
      }
    }, [theme, SCENARIO_KEY, [scene.scenario ?? []].flat().join(",")])
    // Sample data needs nothing from the network. Anything else is stopped and reported.
    await context.route("**/*", (route) => {
      const url = route.request().url()
      if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue()
      problems.push(`asked the network for ${url}`)
      return route.abort()
    })
    const page = await context.newPage()
    page.on("pageerror", (e) => problems.push(`the page threw: ${e.message}`))
    await page.clock.setFixedTime(new Date(`${NOW}${offsetOf(TIME_ZONE, NOW)}`))
    page.setDefaultTimeout(10_000)
    const still = () => settle(page, { loading: !!scene.loading })
    await page.goto(origin + (scene.path ?? "/"))
    await page.addStyleTag({ content: NO_MOTION })
    await page.waitForFunction(() => !!document.getElementById("root")?.innerText.trim())
    await still()
    // The app has loaded; then the connection drops.
    if (scene.offline) await context.setOffline(true)
    const app = { page, size, phone: size === "phone", touch: !!SIZES[size].hasTouch, viewport, theme, settle: still }
    await scene.run?.(app)
    await still()
    await scene.assert?.(app)
    if (problems.length) throw new Error([...new Set(problems)].join("; "))
    mkdirSync(path.dirname(file), { recursive: true })
    await page.screenshot({ path: file, animations: "disabled" })
  } finally {
    await context.close()
  }
  if (problems.length) throw new Error([...new Set(problems)].join("; "))
}

/** The UTC offset of a wall-clock time in a zone, as "+hh:mm". */
function offsetOf(timeZone, wall) {
  const asUtc = new Date(`${wall}Z`)
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(asUtc).map((p) => [p.type, p.value]))
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const minutes = Math.round((shown - asUtc.getTime()) / 60_000)
  const abs = Math.abs(minutes)
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  checkScenes(scenes)
  // A scene of the demo app itself (`demo: true`) only runs with --demo: its screen isn't in the plain build.
  const picked = scenes.filter((s) => (!args.grep.length || args.grep.some((g) => s.name.includes(g))) && (!args.sean || s.sean) && (!s.demo || args.demo))
  if (args.list) return void console.log(picked.map((s) => s.name).join("\n"))
  const asked = [args.grep.length ? `whose name contains ${args.grep.map((g) => `"${g}"`).join(" or ")}` : "", args.sean ? "with sean metadata" : ""].filter(Boolean).join(" and ")
  if (!picked.length) throw new Error(`no scene ${asked}`)
  const jobs = picked.flatMap((scene) => jobsFor(scene, args))
  if (!jobs.length) throw new Error(`no picked scene has the size ${args.sizes.join(" or ")}`)

  if (args.build) {
    const script = args.demo ? "build:demo" : "build"
    const r = spawnSync("pnpm", ["--filter", "web", script], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" })
    if (r.status !== 0) throw new Error(`the web ${script} failed, so no pictures were taken`)
  } else if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error("apps/web/dist is missing: run without --no-build")
  }

  mkdirSync(args.out, { recursive: true })
  const scale = args.sean ? SEAN.scale : 1
  const { server, origin } = await serve()
  const browser = await launch()
  const failed = []
  let next = 0
  const started = Date.now()
  try {
    await Promise.all(
      Array.from({ length: Math.min(args.jobs, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++]
          const file = fileOf(job, args)
          const label = `${job.scene.name}-${job.size}-${job.theme}${args.sean ? ` → ${path.relative(args.out, file)}` : ""}`
          try {
            await shoot(browser, origin, job, file, scale)
            console.log(`ok    ${label}`)
          } catch (e) {
            failed.push(label)
            console.log(`FAIL  ${label}\n      ${String(e?.message ?? e).split("\n").join("\n      ")}`)
          }
        }
      })
    )
  } finally {
    await browser.close()
    server.close()
  }
  const secs = Math.round((Date.now() - started) / 1000)
  console.log(`\n${jobs.length - failed.length} of ${jobs.length} pictures in ${args.out} (${secs} s)`)
  if (failed.length) {
    console.log(`Not taken:\n  ${failed.join("\n  ")}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e?.message ?? e)
  process.exitCode = 1
})
