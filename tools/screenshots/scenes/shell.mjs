// The shell: its chrome (sidebar, rail, top and bottom rows, tab bar), the scrolled state, quick
// create, the limited shells (a team member, the demo), and the ways around the app.
import { area, button, ensure, press, settingsButton, sidebar, tabBar } from "./helpers.mjs"

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
        await page.keyboard.press("Control+Backslash")
        await app.settle()
        ensure((await sidebar(page).getAttribute("data-state")) === "expanded", "⌘\\ did not expand the sidebar")
        // Tab order: the sidebar first, then the content.
        await page.keyboard.press("Tab")
        ensure(await page.evaluate(() => !!document.activeElement?.closest('[data-slot="app-frame-sidebar"]')), "the first Tab stop is not in the sidebar")
        for (let i = 0; i < 12 && (await page.evaluate(() => !!document.activeElement?.closest('[data-slot="app-frame-sidebar"]'))); i++) await page.keyboard.press("Tab")
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
      // Search opens the command menu until Search is a place.
      await press(app, button(page, "Search"))
      ensure(await page.getByRole("dialog", { name: "Command menu" }).isVisible(), "Search did not open the command menu")
      await leave(app)
      // A header control carried into the page head still works: Mail's account choice.
      await page.getByRole("combobox", { name: "Account" }).selectOption({ label: "Work" })
      await app.settle()
      ensure(/Inbox\s*\/\/\s*Work/i.test(await page.locator('[data-slot="page-head-overline"]').first().innerText()), "choosing an account did not change the page head")
      await page.getByRole("combobox", { name: "Account" }).selectOption({ label: "All" })
    },
  },
]
