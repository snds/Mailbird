// The shell: its chrome (sidebar, rail, top and bottom rows, tab bar), the scrolled state, quick
// create, the limited shells (a team member, the demo), and the ways around the app.
import { area, button, ensure, groups, oneCurrent, press, settingsButton, sidebar, switcher, switcherLayer, tabBar } from "./helpers.mjs"
import { send } from "./mail.mjs"
import { noteAction } from "./notes.mjs"

const AREAS = ["Mail", "Calendar", "Contacts", "Notes"]
/** The words quick create lists, and what each one opens. */
const CREATES = [
  ["New message", (page) => page.getByRole("dialog", { name: "New message" })],
  ["New event", (page) => page.getByRole("dialog", { name: "New event" })],
  ["New contact", (page) => page.getByRole("dialog", { name: "New contact" })],
  ["New note", (page) => page.getByRole("article", { name: "Note" })],
  [/^Quick note/, (page) => page.getByRole("dialog", { name: "Quick note" })],
]

/** A section's list column, by the section's name. */
const listOf = (page, name) => page.getByRole("region", { name, exact: true })
const quickCreate = (page) => page.getByRole("menu", { name: "Quick create" })
const crumbs = (page) => page.getByRole("navigation", { name: "Breadcrumb" })
const topRow = (page) => page.locator('[data-slot="app-frame-top-row"]')
const smallTitle = (page) => page.locator('[data-slot="app-frame-top-row-title"]')
const strip = (page) => page.locator('[data-slot="accessory"]')

const statusLine = (page) => page.locator('[data-slot="app-frame-status-line"]')
const statusItems = (page) => statusLine(page).locator('[data-slot="status-item"]')
const toasts = (page) => page.locator("[data-sonner-toast]")
/** Where live status shows: the phone's strip, the desktop's status line. */
const live = ({ page, phone }) => (phone ? strip(page) : statusLine(page).locator('[data-slot="app-frame-status-line-status"]'))
/** What a part says, on one line. */
const said = async (part) => ((await part.count()) ? (await part.first().innerText()).replace(/\s+/g, " ").trim() : "")
/** The place a phone names: the page head's title, or the small title once it has collapsed. */
const smallOrHead = async (page) => (await page.locator('[data-slot="page-head-title"]:visible').first().innerText()).trim()
/** Scrolls Mail's list the way a finger would, far enough for the chrome to minimize. */
const scrollMail = async (app, top) => {
  await listOf(app.page, "Mail").evaluate((el, y) => el.scrollTo(0, y), top)
  await app.settle()
}
/** Holds the create button down past the long-press time. */
const longPress = async (app, name) => {
  await button(app.page, name).click({ delay: 700 })
  await app.settle()
}
/** Takes focus and the pointer off the last control, so its ring and tooltip are not in the picture by chance. */
const rest = async (page) => {
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(0, 0)
  await page.getByRole("tooltip").waitFor({ state: "detached" })
  await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "detached" })
}
/** Leaves whatever a create flow opened: a form closes on Escape; a new note is a pushed screen or a pane. */
const leave = async (app) => {
  await app.page.keyboard.press("Escape")
  await app.settle()
}
/** The section showing, as the shell names it: the breadcrumb's first part, or the phone's active tab. */
const showing = async ({ page }) =>
  (await sidebar(page).count()) ? (await crumbs(page).getByRole("listitem").first().textContent()).trim() : await tabBar(page).getByRole("tab", { selected: true }).getAttribute("aria-label")

export const scenes = [
  {
    // States / 02: the page has scrolled. The mark alone, the place as a small title over a
    // hairline, the tab bar shrunk to the active tab, and the place strip in the bottom row.
    name: "shell-scrolled",
    sizes: ["phone"],
    sean: { kind: "drawn", area: "shell", screen: "scrolled" },
    run: async (app) => {
      const { page } = app
      await scrollMail(app, 400)
      ensure((await topRow(page).getAttribute("data-minimized")) !== null, "the chrome did not minimize on scroll")
      // A second tap on the active tab: back to the section's first screen, at the top.
      await press(app, tabBar(page).getByRole("tab", { name: "Mail", exact: true }))
      ensure((await listOf(page, "Mail").evaluate((el) => el.scrollTop)) === 0, "a second tap on the active tab did not return to the top")
      ensure((await topRow(page).getAttribute("data-minimized")) === null, "the chrome stayed minimized at the top")
      await scrollMail(app, 472)
    },
    assert: async ({ page }) => {
      ensure((await smallTitle(page).innerText()).trim() === "Inbox", `the small title is not the place: ${await smallTitle(page).innerText()}`)
      ensure((await tabBar(page).getAttribute("data-minimized")) !== null, "the tab bar did not shrink to the active tab")
      ensure(await strip(page).isVisible(), "the place strip is not in the bottom row")
      ensure(/^Inbox/i.test((await strip(page).innerText()).trim()), "the place strip does not start with the lane")
      ensure(!/unread/i.test(await strip(page).innerText()), "the place strip shows an unread count the core does not have")
    },
  },
  {
    // States / 03: a long press on create opens quick create above it, over the menu scrim.
    name: "shell-quick-create",
    sizes: ["phone"],
    sean: { kind: "drawn", area: "shell", screen: "quick-create" },
    run: async (app) => {
      const { page } = app
      await longPress(app, "Compose")
      ensure(await quickCreate(page).isVisible(), "a long press on create did not open quick create")
      ensure(await button(page, "Close quick create").count(), "the create button does not show close while the menu is open")
      await press(app, quickCreate(page).getByRole("menuitem", { name: "New event" }))
      ensure(await page.getByRole("dialog", { name: "New event" }).isVisible(), "New event did not open its form")
      await leave(app)
      ensure((await showing(app)) === "Calendar", "New event did not open Calendar")
      // A plain tap makes the open section's item, with no menu.
      await press(app, button(page, "New event"))
      ensure(await page.getByRole("dialog", { name: "New event" }).isVisible(), "a tap on create did not make the section's item")
      ensure(!(await quickCreate(page).count()), "a tap on create opened quick create")
      await leave(app)
      await area(app, "Mail")
      // A swipe up on create opens it too.
      await button(page, "Compose").evaluate((el) => {
        const at = el.getBoundingClientRect()
        const touch = (y) => new Touch({ identifier: 1, target: el, clientX: at.x + at.width / 2, clientY: y })
        const send = (type, y, lifted = false) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: lifted ? [] : [touch(y)], changedTouches: [touch(y)] }))
        send("touchstart", at.y + at.height / 2)
        send("touchmove", at.y - 40)
        send("touchend", at.y - 40, true)
      })
      await app.settle()
      ensure(await quickCreate(page).isVisible(), "a swipe up on create did not open quick create")
      await leave(app)
      await longPress(app, "Compose")
    },
    assert: async ({ page }) => {
      const rows = await quickCreate(page).getByRole("menuitem").allInnerTexts()
      ensure(rows.length === 5 && rows[0].trim() === "New message" && /^Quick note/.test(rows[4].trim()), `quick create lists ${JSON.stringify(rows)}`)
      ensure(await page.locator('[data-slot="dropdown-menu-scrim"]').isVisible(), "quick create has no scrim")
    },
  },
  {
    // The same menu from the sidebar's and the rail's create button: a right-click, or Shift+F10.
    name: "shell-quick-create-desktop",
    sizes: ["desktop", "medium"],
    run: async (app) => {
      const { page } = app
      for (const [name, opened] of CREATES) {
        await area(app, "Mail")
        await button(page, "Compose").click({ button: "right" })
        await app.settle()
        ensure(await quickCreate(page).isVisible(), "a right-click on create did not open quick create")
        await press(app, quickCreate(page).getByRole("menuitem", { name }))
        ensure(await opened(page).isVisible(), `${name} did not open its create flow`)
        await leave(app)
      }
      await area(app, "Mail")
      // The keyboard's way: Shift+F10 (or the Menu key) on the create button.
      await button(page, "Compose").focus()
      await page.keyboard.press("Shift+F10")
      await app.settle()
      ensure(await quickCreate(page).isVisible(), "Shift+F10 on create did not open quick create")
      await leave(app)
      ensure(!(await quickCreate(page).count()), "Escape did not close quick create")
      await button(page, "Compose").click({ button: "right" })
    },
    assert: async ({ page }) => ensure(await quickCreate(page).isVisible(), "quick create is not open"),
  },
  {
    // A team member on a gateway has Mail only (brief X10): no APPS group, no tab bar. Search and create stay.
    name: "shell-member",
    scenario: "member",
    sean: { kind: "undrawn", area: "shell", screen: "member" },
    assert: async ({ page }) => {
      if (await sidebar(page).count()) {
        for (const name of AREAS) ensure(!(await sidebar(page).getByRole("button", { name, exact: true }).count()), `${name} is in a team member's sidebar`)
        ensure(!(await sidebar(page).getByText("Apps", { exact: false }).count()), "a team member's sidebar has the APPS group")
      } else {
        ensure(!(await tabBar(page).count()), "a team member's phone has a tab bar")
      }
      ensure(await button(page, "Search").isVisible(), "a team member has no Search")
      ensure(await button(page, "Compose").isVisible(), "a team member has no create button")
      // The pointer's way on a desktop, the finger's on a phone.
      if (await sidebar(page).count()) await button(page, "Compose").click({ button: "right" })
      else await button(page, "Compose").click({ delay: 700 })
      await quickCreate(page).waitFor()
      const rows = await quickCreate(page).getByRole("menuitem").allInnerTexts()
      ensure(rows.length === 1 && rows[0].trim() === "New message", `a team member's quick create lists ${JSON.stringify(rows)}`)
      await page.keyboard.press("Escape")
      await quickCreate(page).waitFor({ state: "detached" })
      await rest(page)
    },
  },
  {
    // The demo app says what it is on every screen, a pushed one too (brief X10). Only in the demo build: --demo.
    name: "shell-demo",
    demo: true,
    sean: { kind: "undrawn", area: "shell", screen: "demo" },
    run: async (app) => {
      const { page } = app
      const notice = page.locator('[data-role="demo-bar"]:visible')
      await press(app, listOf(page, "Mail").getByRole("button", { name: /Token audit/ }).first())
      ensure((await notice.count()) === 1, "the demo's notice is not on an open conversation")
      if (await button(page, "Back").count()) await press(app, button(page, "Back"))
    },
    assert: async ({ page }) => {
      const notice = page.locator('[data-role="demo-bar"]:visible')
      ensure((await notice.count()) >= 1, "the demo's notice is not on the screen")
      ensure(/You’re exploring the demo\. Nothing here is real\./.test(await notice.first().innerText()), "the demo's notice does not say what it is")
      ensure(await notice.first().getByRole("button", { name: "Reset the demo" }).isVisible(), "the demo's notice has no Reset the demo")
      ensure(!(await notice.first().getByRole("button", { name: "Dismiss" }).count()), "the demo's notice can be dismissed")
    },
  },
  {
    // Medium width: the sidebar as its rail, one content column, a pushed detail with its way back in the status line.
    name: "shell-medium",
    sizes: ["medium"],
    run: async (app) => {
      const { page } = app
      ensure((await sidebar(page).getAttribute("data-state")) === "rail", "the sidebar is not its rail at medium width")
      await press(app, listOf(page, "Mail").getByRole("button", { name: /Token audit/ }).first())
      ensure(!(await listOf(page, "Mail").isVisible()), "an open conversation did not push over the list at medium width")
      await press(app, page.getByRole("banner").getByRole("button", { name: "Back" }))
      ensure(await listOf(page, "Mail").isVisible(), "the status line's back button did not return to the list")
    },
  },
  {
    // A phone on its side: the bottom row stands as a column at the trailing edge, the tab bar turned.
    name: "shell-landscape",
    sizes: ["landscape"],
    sean: { kind: "undrawn", area: "shell", screen: "landscape" },
    assert: async ({ page }) => {
      ensure((await tabBar(page).getAttribute("aria-orientation")) === "vertical", "the tab bar is not vertical on a short screen")
      ensure(await button(page, "Compose").isVisible(), "create is not on a short screen")
    },
  },
  {
    // An update is ready: a mark on the way into Settings, and nowhere else (cross-app decisions §3).
    name: "shell-update-mark",
    scenario: "update-ready",
    sizes: ["desktop", "phone", "medium"],
    assert: async ({ page }) => {
      const name = await settingsButton(page).getAttribute("aria-label")
      ensure(/^Settings, Update ready$/.test(name ?? ""), `the way into Settings is named ${JSON.stringify(name)}, not "Settings, Update ready"`)
      ensure(!(await page.locator("[data-sonner-toast]").count()), "an update that is ready raised a toast")
    },
  },
  {
    // Every way around: each section, Settings three ways, the sidebar's collapse, the keys that stay.
    name: "shell-navigation",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const { page } = app
      const desktop = !!(await sidebar(page).count())
      for (const name of [...AREAS.slice(1), "Mail"]) {
        await area(app, name)
        ensure((await showing(app)) === name, `${name} did not open from the navigation`)
        ensure(await listOf(page, name).or(page.getByRole("region", { name })).first().isVisible(), `${name}'s screen is not showing`)
      }
      // Settings: the sidebar's or rail's item, or the phone's top-right button; then back.
      await press(app, settingsButton(page))
      ensure(await page.getByRole("heading", { name: "Settings", level: 1 }).isVisible(), "the Settings button did not open Settings")
      await area(app, "Mail")
      ensure(!(await page.getByRole("heading", { name: "Settings", level: 1 }).count()), "Settings did not close")
      // ⌘, opens it too.
      await page.keyboard.press("Control+Comma")
      await app.settle()
      ensure(await page.getByRole("heading", { name: "Settings", level: 1 }).isVisible(), "⌘, did not open Settings")
      await area(app, "Mail")
      if (desktop && app.size === "desktop") {
        // ⌘\ collapses the sidebar to its rail and brings it back.
        await page.keyboard.press("Control+Backslash")
        await app.settle()
        ensure((await sidebar(page).getAttribute("data-state")) === "rail", "⌘\\ did not collapse the sidebar")
        // Beside the rail the page head is the way to the folders, as at medium width (ADR-0084).
        ensure((await switcher(page).count()) === 1, "the page head is not the switcher beside the rail")
        ensure(!(await sidebar(page).locator('[aria-label="Inbox"]').count()), "the rail lists the folders")
        await page.keyboard.press("Control+Backslash")
        await app.settle()
        ensure((await sidebar(page).getAttribute("data-state")) === "expanded", "⌘\\ did not expand the sidebar")
        ensure(!(await switcher(page).count()), "the page head is still a switcher beside the full sidebar")
        // Tab order: the sidebar first (its head, Search, Apps, the section's own groups, Settings), then the content.
        await page.keyboard.press("Tab")
        ensure(await page.evaluate(() => !!document.activeElement?.closest('[data-slot="app-frame-sidebar"]')), "the first Tab stop is not in the sidebar")
        for (let i = 0; i < 40 && (await page.evaluate(() => !!document.activeElement?.closest('[data-slot="app-frame-sidebar"]'))); i++) await page.keyboard.press("Tab")
        ensure(await page.evaluate(() => !!document.activeElement?.closest('[data-slot="app-frame-status-line"], [data-slot="app-frame-main"]')), "Tab does not go from the sidebar to the content")
        await page.evaluate(() => document.activeElement?.blur())
      }
      // The keys that stay: ⌘K and ?.
      await page.keyboard.press("Control+KeyK")
      await app.settle()
      ensure(await page.getByRole("dialog", { name: "Command menu" }).isVisible(), "⌘K did not open the command menu")
      await leave(app)
      await page.keyboard.press("?")
      await app.settle()
      ensure(await page.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible(), "? did not open the keys list")
      await leave(app)
      // Search is a place (ADR-0085): its button opens it, and Esc with nothing typed leaves it. search.mjs checks the rest.
      await press(app, button(page, "Search"))
      ensure(await page.getByRole("searchbox", { name: /^Search / }).isVisible(), "Search did not open")
      await page.keyboard.press("Escape")
      await app.settle()
      ensure(!(await page.getByRole("searchbox", { name: /^Search / }).count()), "Esc did not leave Search")
      // A header control carried into the page head still works: Mail's account choice.
      // Mail's account choice, now a radio group in Mail's folders (ADR-0084): the sidebar, or the page head's layer.
      await press(app, (await groups(app)).getByRole("radio", { name: "Work", exact: true }))
      ensure(/Inbox\s*\/\/\s*Work/i.test(await page.locator('[data-slot="page-head-overline"]').first().innerText()), "choosing an account did not change the page head")
      await press(app, (await groups(app)).getByRole("radio", { name: "All", exact: true }))
    },
  },
  {
    // Medium width (ADR-0084; brief X1): the rail has no groups, so the page head is the switcher
    // and opens them in a popover under it, 320 wide.
    name: "switcher-medium",
    sizes: ["medium"],
    sean: { kind: "undrawn", area: "shell", screen: "switcher-medium", sizes: ["medium"] },
    run: async (app) => {
      await groups(app)
    },
    assert: async (app) => {
      const { page } = app
      const layer = switcherLayer(page)
      ensure(await layer.isVisible(), "the page head did not open the folders")
      const box = await layer.boundingBox()
      ensure(Math.round(box.width) === 320, `the popover is ${Math.round(box.width)} wide, not 320`)
      const head = await switcher(page).first().boundingBox()
      ensure(box.y >= head.y + head.height - 8, "the popover does not stand under the page head")
      ensure(!(await sidebar(page).locator('[aria-label="Inbox"]').count()), "the rail lists the folders")
      ensure((await oneCurrent(sidebar(page), "the rail")) === "Mail", "Mail is not the rail's current item")
      ensure((await oneCurrent(layer, "the popover")) === "Inbox", "the Inbox is not the popover's current place")
      // Every section's head is its switcher here.
      await page.keyboard.press("Escape")
      await app.settle()
      for (const [name, title] of [["Calendar", "Calendars"], ["Contacts", "Groups"], ["Notes", "Folders"]]) {
        await area(app, name)
        await groups(app)
        ensure(await page.getByRole("dialog", { name: title, exact: true }).isVisible(), `${name}'s page head did not open its ${title.toLowerCase()}`)
        await page.keyboard.press("Escape")
        await app.settle()
      }
      await area(app, "Mail")
      await groups(app)
    },
  },
  // ── Status and messages (ADR-0086; brief X4) ────────────────────────────────────────────────
  {
    // States / 04: a check for mail the person asked for. The strip on a phone, the first status
    // item on a desktop; the scenario holds the check, so it stays up.
    name: "status-syncing",
    sizes: ["desktop", "phone", "medium"],
    scenario: "syncing",
    sean: { kind: "undrawn", area: "shell", screen: "status-syncing" },
    run: async (app) => {
      const { page } = app
      ensure(!(await live(app).filter({ hasText: /syncing|checking/i }).count()), "something says it is checking before anyone asked")
      if (app.phone) {
        // A second tap on Mail's tab reads again.
        await press(app, tabBar(page).getByRole("tab", { name: "Mail", exact: true }))
        // The strip's text area is a button: while mail is fetched it opens the Folders sheet.
        await press(app, strip(page).locator('[data-slot="accessory-open"]'))
        ensure(await page.getByRole("dialog", { name: "Folders", exact: true }).isVisible(), "the syncing strip did not open the Folders sheet")
        await leave(app)
      } else {
        const again = statusLine(page).getByRole("button", { name: "Check again", exact: true })
        await again.hover()
        await page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Check for new mail" }).waitFor()
        await press(app, again)
      }
      await rest(page)
    },
    assert: async (app) => {
      const { page } = app
      if (app.phone) {
        const words = await said(strip(page))
        ensure(/^SYNCING \/\/ PERSONAL \+ WORK Checking 2 accounts$/i.test(words), `the strip says “${words}”`)
        ensure((await strip(page).getAttribute("data-tone")) === "live", "the syncing strip is not live")
        ensure(await strip(page).locator('[data-slot="accessory-open"]').count(), "the strip's text area is not a button")
      } else {
        const items = await statusItems(page).allInnerTexts()
        ensure(items.length === 2 && /^CHECKING \/\/ 2 ACCOUNTS$/i.test(items[0].trim()) && /^SYNCED \/\/ 09:16$/i.test(items[1].trim()), `the status line says ${JSON.stringify(items)}`)
        ensure((await statusItems(page).first().getAttribute("data-tone")) === "live", "the live item is not first")
        ensure(!(await statusLine(page).getByRole("button", { name: "Check again" }).count()), "Check again is still offered while checking")
      }
      ensure(!(await toasts(page).count()), "a check for mail raised a toast")
    },
  },
  {
    // An account added a moment ago: its first sync is live until it has synced once.
    name: "status-first-sync",
    sizes: ["desktop", "phone", "medium"],
    scenario: "first-sync",
    assert: async (app) => {
      const words = await said(app.phone ? strip(app.page) : statusItems(app.page).first())
      ensure(app.phone ? /^FIRST SYNC \/\/ WORK Fetching mail$/i.test(words) : /^FIRST SYNC \/\/ WORK$/i.test(words), `the first sync reads “${words}”`)
      ensure((await (app.phone ? strip(app.page) : statusItems(app.page).first()).getAttribute("data-tone")) === "live", "the first sync is not live")
    },
  },
  {
    // A send in its undo window: SENDING // NN S with UNDO, on the strip and on the line, never a
    // toast. UNDO reopens the message; two sends show the newest; Ctrl+Z takes it back.
    name: "status-sending",
    sizes: ["desktop", "phone", "medium"],
    sean: { kind: "undrawn", area: "shell", screen: "status-sending" },
    run: async (app) => {
      const { page } = app
      const message = page.getByRole("dialog", { name: "New message" })
      const subject = message.getByRole("textbox", { name: "Subject" })
      await send(app, "Saturday ferry")
      ensure(/SENDING \/\/ 10 S/i.test(await said(live(app))), `after Send the status says “${await said(live(app))}”`)
      ensure(!(await toasts(page).count()), "Send raised a toast while its undo window is open")
      // UNDO is its own button: it reopens the message as it was.
      await press(app, live(app).getByRole("button", { name: "Undo", exact: true }))
      ensure((await subject.inputValue()) === "Saturday ferry", "Undo did not reopen the message")
      ensure(!(await live(app).filter({ hasText: /sending/i }).count()), "the status still says Sending after Undo")
      await press(app, message.getByRole("button", { name: "Send", exact: true }))
      await message.waitFor({ state: "detached" })
      // A second send inside the window: the status shows the newest and counts both.
      await send(app, "Pier parking")
      ensure(/SENDING \/\/ 2 MESSAGES \/\/ 10 S/i.test(await said(live(app))), `two sends read “${await said(live(app))}”`)
      if (app.phone) ensure(/Pier parking/.test(await said(strip(page))), "the strip does not name the newest send")
      // Ctrl+Z outside a text field takes back the newest.
      await rest(page)
      await page.keyboard.press("Control+KeyZ")
      await app.settle()
      ensure((await subject.inputValue()) === "Pier parking", "Ctrl+Z did not take back the newest send")
      // In a text field the key is the field's own undo.
      await subject.focus()
      await page.keyboard.press("Control+KeyZ")
      await app.settle()
      ensure(/SENDING \/\/ 10 S/i.test(await said(app.phone ? message.locator('[data-slot="accessory"]') : live(app))), "Ctrl+Z in a text field took back a send")
      // On a phone the strip shows in the full-screen form too, and on Settings, which has no bottom row.
      if (app.phone) ensure(await message.locator('[data-slot="accessory"]').getByRole("button", { name: "Undo" }).isVisible(), "the sending strip is not in the full-screen form")
      await leave(app)
      if (app.phone) {
        // Scrolled, the strip joins the bottom row and shows the seconds and UNDO only.
        await scrollMail(app, 400)
        ensure((await said(strip(page))) === "10 S", `in the bottom row the strip says “${await said(strip(page))}”`)
        ensure(await strip(page).getByRole("button", { name: "Undo", exact: true }).isVisible(), "in the bottom row the strip has no UNDO")
        await scrollMail(app, 0)
        await press(app, settingsButton(page))
        ensure(await strip(page).isVisible(), "the sending strip does not show on Settings")
        const box = await strip(page).boundingBox()
        ensure(Math.round(box.x) === 16 && Math.round(box.x + box.width) === app.viewport.width - 16, `alone at the foot the strip spans ${Math.round(box.x)} to ${Math.round(box.x + box.width)}`)
        await press(app, button(page, "Back"))
        // Its text area opens Scheduled, where the message waits.
        await press(app, strip(page).locator('[data-slot="accessory-open"]'))
        ensure((await smallOrHead(page)) === "Scheduled", "the sending strip did not open Scheduled")
        await press(app, tabBar(page).getByRole("tab", { name: "Mail", exact: true }))
      }
      // Two seconds on.
      const now = await page.evaluate(() => Date.now())
      await page.clock.setFixedTime(new Date(now + 2000))
      await live(app).filter({ hasText: /08 S/ }).waitFor()
      await rest(page)
    },
    assert: async (app) => {
      const { page } = app
      const words = await said(live(app))
      ensure(/SENDING \/\/ 08 S/i.test(words) && !/MESSAGES/i.test(words), `the status says “${words}”`)
      ensure(await live(app).getByRole("button", { name: "Undo", exact: true }).isVisible(), "there is no UNDO")
      ensure(await live(app).locator('[data-slot="accessory-progress"], [data-slot="status-item-progress"]').count(), "there is no progress bar")
      if (app.phone) ensure(/Saturday ferry/.test(words), "the strip does not name the message")
      else {
        ensure((await statusItems(page).count()) === 2, "the status line holds more than the live item and the screen's fact")
        ensure((await statusItems(page).first().getAttribute("data-tone")) === "live", "the live item is not first")
      }
      ensure(!(await toasts(page).count()), "a toast shows while the send can still be undone")
    },
  },
  {
    // Desktop / 05, Mobile / 07: an account stopped syncing. A critical status item in place of the
    // sync time, and Mail's banner. Never yellow, never a strip.
    name: "status-sync-error",
    sizes: ["desktop", "phone", "medium"],
    scenario: "sync-error",
    sean: { kind: "undrawn", area: "shell", screen: "status-sync-error" },
    assert: async (app) => {
      const { page } = app
      const banner = page.locator('[data-role="section-banner"]:visible')
      ensure((await banner.count()) === 1, `Mail shows ${await banner.count()} banners, not one`)
      ensure(/Work account stopped syncing/.test(await banner.innerText()), "the banner does not name the account")
      ensure(await banner.getByRole("button", { name: "Open Accounts", exact: true }).isVisible(), "the banner has no way to fix it")
      ensure(!(await page.locator('[data-tone="needs-you"]').count()), "a sync error is yellow")
      if (app.phone) {
        ensure(!(await strip(page).isVisible()), "a sync error shows as a strip on a phone")
        const head = await page.locator('[data-slot="page-head-title"]:visible').first().boundingBox()
        const box = await banner.boundingBox()
        ensure(box.y > head.y + head.height, "the banner is not under the page head")
      } else {
        const items = await statusItems(page).allInnerTexts()
        ensure(items.length === 1 && /^WORK \/\/ NOT SYNCING SINCE 08:36$/i.test(items[0].trim()), `the status line says ${JSON.stringify(items)}`)
        ensure((await statusItems(page).first().getAttribute("data-tone")) === "critical", "the item is not critical")
        const line = await statusLine(page).boundingBox()
        const box = await banner.boundingBox()
        ensure(box.y >= line.y + line.height && Math.abs(box.x - line.x) < 1 && Math.abs(box.width - line.width) < 1, "the banner does not stand under the status line, across the content")
      }
      // The banner belongs to Mail: another section shows none, and the line still says what stopped.
      await area(app, "Contacts")
      ensure(!(await banner.count()), "Mail's banner shows in Contacts")
      if (!app.phone) ensure((await statusItems(page).count()) === 2, "outside Mail the line should hold the critical item and the screen's fact")
      await area(app, "Mail")
      await rest(page)
    },
  },
  {
    // No network: a neutral fact with the last sync. The demo says so only under this scenario.
    name: "status-offline",
    sizes: ["desktop", "phone", "medium"],
    scenario: "offline",
    offline: true,
    assert: async (app) => {
      const { page } = app
      const part = app.phone ? strip(page) : statusItems(page).first()
      const words = await said(part)
      ensure(app.phone ? /^OFFLINE Last synced 09:16$/i.test(words) : /^OFFLINE \/\/ LAST SYNCED 09:16$/i.test(words), `offline reads “${words}”`)
      if (!app.phone) ensure((await statusItems(page).count()) === 1, "Mail's sync time shows beside Offline, which already says it")
      ensure((await part.getAttribute("data-tone")) === "neutral", "offline is not neutral")
    },
  },
  {
    // Two reminders came due while Vale was closed: one notice, and SEE opens the Missed list.
    name: "status-missed",
    scenario: "missed",
    run: async (app) => {
      const { page } = app
      const notice = toasts(page).filter({ hasText: "2 reminders came due while Vale was closed" })
      await notice.waitFor()
      ensure((await toasts(page).count()) === 1, "missed reminders raised more than one toast")
      await press(app, notice.getByRole("button", { name: "See", exact: true }))
    },
    assert: async ({ page }) => {
      const list = page.getByRole("dialog", { name: "Missed", exact: true })
      ensure(await list.isVisible(), "SEE did not open the Missed list")
      ensure((await list.getByRole("list", { name: "Missed reminders" }).getByRole("listitem").count()) === 2, "the Missed list does not hold both reminders")
    },
  },
  {
    // The browser refuses the clipboard: the value shows in a toast, to select and copy by hand.
    name: "status-copy-blocked",
    run: async (app) => {
      const { page } = app
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("blocked", "NotAllowedError")) } }))
      // A copy from a menu: the note's "Copy as Markdown".
      await noteAction(app, "Copy as Markdown")
      await page.locator('[data-role="copy-value"]').waitFor()
      await rest(page)
    },
    assert: async ({ page }) => {
      const toast = toasts(page).filter({ has: page.locator('[data-role="copy-value"]') })
      ensure(/Note as Markdown/.test(await toast.innerText()), "the toast does not say what the value is")
      ensure(/Cabin packing list/.test(await page.locator('[data-role="copy-value"]').innerText()), "the toast does not show the text")
      ensure((await page.locator('[data-role="copy-value"]').evaluate((el) => getComputedStyle(el).userSelect)) === "all", "the value cannot be selected")
    },
  },
]
