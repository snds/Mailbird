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
}
const THEMES = ["light", "dark"]

/**
 * Motion is off while pictures are taken. A dialog that animates open keeps
 * icon pixels from part-way through, and they differ from run to run.
 */
const NO_MOTION = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; }"

function usage() {
  console.log(`usage: pnpm shots [--out <folder>] [-g <text>] [--size desktop|phone] [--theme light|dark]
                  [--jobs <n>] [--no-build] [--list]

  --out <folder>   where the pictures go (default: tools/screenshots/out)
  -g <text>        only scenes whose name contains <text>, e.g. -g calendar
  --size, --theme  only that size or theme
  --jobs <n>       pictures taken at once (default: 4, or the number of cores if lower)
  --no-build       use apps/web/dist as it is, without building first
  --list           print the scene names and stop

  VALE_SHOTS_CHROME=<path>  the browser to drive. Without it: Playwright's own Chromium
                            when it is installed, else the Chrome on this machine.`)
}

function parseArgs(argv) {
  const a = { out: path.join(here, "out"), grep: null, size: null, theme: null, jobs: Math.min(4, availableParallelism()), build: true, list: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`)
      return argv[++i]
    }
    // pnpm runs the script from the repository root; a relative folder means the one you typed it in.
    if (k === "--out") a.out = path.resolve(process.env.INIT_CWD ?? process.cwd(), value())
    else if (k === "-g" || k === "--grep") a.grep = value()
    else if (k === "--size") a.size = value()
    else if (k === "--theme") a.theme = value()
    else if (k === "--jobs") a.jobs = Math.max(1, Number(value()) || 1)
    else if (k === "--no-build") a.build = false
    else if (k === "--list") a.list = true
    else if (k === "-h" || k === "--help") {
      usage()
      process.exit(0)
    }
    else throw new Error(`unknown option ${k}`)
  }
  if (a.size && !SIZES[a.size]) throw new Error(`--size is desktop or phone, not ${a.size}`)
  if (a.theme && !THEMES.includes(a.theme)) throw new Error(`--theme is light or dark, not ${a.theme}`)
  return a
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
 * for a moment. A screen that never gets there fails its picture.
 */
async function settle(page) {
  const still = await page.evaluate(async () => {
    const QUIET_MS = 300
    const GIVE_UP_MS = 8000
    await document.fonts.ready
    const loading = () => !!document.querySelector('[aria-busy="true"], [data-slot="skeleton"]')
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
        if (loading() || moving()) last = now
        if (now - last >= QUIET_MS) done(true)
        else if (now - started > GIVE_UP_MS) done(loading() ? "something is still loading" : moving() ? "something is still moving" : "the page keeps changing")
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await document.fonts.ready
    return result
  })
  if (still !== true) throw new Error(`the screen never settled: ${still}`)
}

async function shoot(browser, origin, job, out) {
  const { scene, size, theme } = job
  const context = await browser.newContext({ ...SIZES[size], deviceScaleFactor: 1, colorScheme: theme, locale: LOCALE, timezoneId: TIME_ZONE })
  const problems = []
  try {
    // The app's own theme choice, where it keeps one (next-themes), follows the picture's theme.
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("theme", t)
      } catch {
        // No storage: the browser's color scheme still decides.
      }
    }, theme)
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
    await page.goto(origin + (scene.path ?? "/"))
    await page.addStyleTag({ content: NO_MOTION })
    await page.waitForFunction(() => !!document.getElementById("root")?.innerText.trim())
    await settle(page)
    await scene.run?.({ page, phone: size === "phone", size, theme, settle: () => settle(page) })
    await settle(page)
    await page.screenshot({ path: path.join(out, `${scene.name}-${size}-${theme}.png`), animations: "disabled" })
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
  const names = new Set()
  for (const s of scenes) {
    if (names.has(s.name)) throw new Error(`two scenes are named ${s.name}`)
    names.add(s.name)
  }
  const picked = scenes.filter((s) => !args.grep || s.name.includes(args.grep))
  if (args.list) return void console.log(picked.map((s) => s.name).join("\n"))
  if (!picked.length) throw new Error(`no scene's name contains "${args.grep}"`)

  if (args.build) {
    const r = spawnSync("pnpm", ["--filter", "web", "build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" })
    if (r.status !== 0) throw new Error("the web build failed, so no pictures were taken")
  } else if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error("apps/web/dist is missing: run without --no-build")
  }

  const jobs = []
  for (const scene of picked)
    for (const size of Object.keys(SIZES))
      for (const theme of THEMES)
        if ((!args.size || args.size === size) && (!args.theme || args.theme === theme) && (!scene.only || scene.only === size)) jobs.push({ scene, size, theme })

  mkdirSync(args.out, { recursive: true })
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
          const label = `${job.scene.name}-${job.size}-${job.theme}`
          try {
            await shoot(browser, origin, job, args.out)
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
