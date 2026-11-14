// Search as a place (ADR-0085), the command menu (⌘K) and the keys list (`?`).
import { area, button, ensure, goBack, headTitle, press, tabBar } from "./helpers.mjs"
import { lane } from "./mail.mjs"
import { settings } from "./settings.mjs"

/** The Search screen's field, whatever it is looking through. */
const field = (page) => page.getByRole("searchbox", { name: /^Search / })
const chips = (page) => page.getByRole("radiogroup", { name: "Search in" })
const results = (page) => page.getByRole("region", { name: "Results" })
const onSearch = (page) => field(page).isVisible()

/** Opens Search by its button: the sidebar's or the rail's item, or the phone's search button. */
const open = async (app) => {
  await press(app, button(app.page, "Search"))
  await field(app.page).waitFor()
}
/** Types into Search and waits for the results to stand still. */
const type = async (app, words) => {
  await field(app.page).fill(words)
  await app.settle()
}
/** The pointer and the cursor leave what they last touched: no hover and no caret in the picture by chance. */
const rest = async (app) => {
  await app.page.mouse.move(0, 0)
  await app.settle()
}

/** Only Search says it is the current place: its item in the sidebar, or its button on a phone, where no tab is marked. */
const searchIsCurrent = async (app) => {
  const { page } = app
  // The breadcrumb's last part says so too, as a breadcrumb does; it is not a way to go anywhere.
  const current = page.locator('[aria-current="page"]:visible:not([data-slot="app-frame-crumbs"] *)')
  const names = await current.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent))
  ensure(names.length === 1 && /^Search/.test(names[0] ?? ""), `on Search, the current items are: ${names.join(" | ") || "none"}`)
  if (await tabBar(page).count()) ensure(!(await tabBar(page).getByRole("tab", { selected: true }).count()), "a tab is marked on Search")
}

export const scenes = [
  {
    name: "mail-search",
    run: async (app) => {
      await open(app)
      await type(app, "cabin")
      await rest(app)
    },
    assert: async ({ page }) => {
      // Opened from the Inbox, it stays inside it: the lane chip is there and is the one chosen.
      ensure(await chips(page).getByRole("radio", { name: /^Inbox/ }).isChecked(), "Search from the Inbox is not inside the Inbox")
      ensure((await results(page).locator('[data-slot="list-row-main"]').count()) > 0, "“cabin” finds nothing in the Inbox")
    },
  },
  {
    name: "mail-search-none",
    run: async (app) => {
      await open(app)
      await type(app, "zeppelin")
      await rest(app)
    },
    assert: async ({ page }) => ensure(await page.getByText("Nothing matches.").isVisible(), "no empty state for a search with no match"),
  },
  {
    // Search in a lane of Mail (ADR-0085): the ways in, what is current, and the way out.
    name: "search-mail",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const { page } = app
      // The search key opens Search from every section, looking through that section's kind.
      for (const [section, chip] of [
        ["Mail", "Inbox"],
        ["Calendar", "Calendar"],
        ["Contacts", "Contacts"],
        ["Notes", "Notes"],
      ]) {
        await area(app, section)
        await page.evaluate(() => document.activeElement?.blur())
        await page.keyboard.press("/")
        await app.settle()
        ensure(await onSearch(page), `the search key did not open Search from ${section}`)
        ensure(await field(page).evaluate((el) => el === document.activeElement), `from ${section}, the cursor is not in the field`)
        ensure(await chips(page).getByRole("radio", { name: new RegExp(`^${chip}`) }).isChecked(), `from ${section}, Search does not look in ${chip}`)
        await searchIsCurrent(app)
        // Esc with nothing typed leaves for where you came from.
        await page.keyboard.press("Escape")
        await app.settle()
        ensure(!(await onSearch(page)), `Esc did not leave Search (from ${section})`)
      }
      // From a lane other than the Inbox, and back to it: Esc clears first, then leaves.
      await area(app, "Mail")
      await lane(app, "Starred")
      await open(app)
      ensure(await chips(page).getByRole("radio", { name: /^Starred/ }).isChecked(), "Search from Starred is not inside Starred")
      await type(app, "cabin")
      await page.keyboard.press("Escape")
      await app.settle()
      ensure((await onSearch(page)) && (await field(page).inputValue()) === "", "Esc did not clear the words first")
      await page.keyboard.press("Escape")
      await app.settle()
      ensure(!(await onSearch(page)), "a second Esc did not leave Search")
      ensure((await headTitle(page)) === "Starred", "leaving Search did not return to Starred")
      // A result opens where it lives; Back returns to the results with the words kept.
      await lane(app, "Inbox")
      await open(app)
      await type(app, "cabin")
      await press(app, results(page).locator('[data-slot="list-row-main"]').first())
      ensure(!(await onSearch(page)), "a result did not open in its section")
      ensure(await page.getByRole("region", { name: "Mail: what is open" }).isVisible(), "the conversation did not open in Mail")
      await goBack(app)
      // A phone and the medium width push the conversation, so one more step back reaches Search.
      if (!(await onSearch(page))) await goBack(app)
      ensure((await onSearch(page)) && (await field(page).inputValue()) === "cabin", "Back from a result did not return to the words")
      await searchIsCurrent(app)
      await rest(app)
    },
  },
  {
    // Search everything (ADR-0085): the four kinds, three rows each, and what the old fields found.
    name: "search-all",
    run: async (app) => {
      const { page } = app
      // ⌘K's settings rows are the settings page's sections, from one list.
      await settings(app)
      const names = await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button").evaluateAll((els) => els.map((el) => el.textContent.trim()).filter((t) => !/^Sign out/.test(t)))
      ensure(names.includes("Notifications") && !names.includes("Notes"), `the settings sections are: ${names.join(", ")}`)
      await page.keyboard.press("Control+KeyK")
      await app.settle()
      const menu = page.getByRole("dialog", { name: "Command menu" })
      await menu.getByRole("combobox").fill("settings")
      for (const name of names) ensure(await menu.getByRole("option", { name, exact: true }).count(), `⌘K has no row for the settings section “${name}”`)
      // Its search rows open Search: the last one, everything.
      await menu.getByRole("combobox").fill("sam")
      await press(app, menu.getByRole("option", { name: /^Search everything for/ }))
      ensure(await onSearch(page), "⌘K's “Search everything” did not open Search")
      ensure(await chips(page).getByRole("radio", { name: /^All/ }).isChecked(), "“Search everything” is not looking in All")
      ensure((await field(page).inputValue()) === "sam", "the words did not come along from ⌘K")
      // The contacts and notes searches find what the old fields found.
      await press(app, chips(page).getByRole("radio", { name: /^Contacts/ }))
      await type(app, "priya")
      ensure(await results(page).getByText("Priya Raman").count(), "Contacts search does not find Priya Raman")
      await press(app, chips(page).getByRole("radio", { name: /^Notes/ }))
      await type(app, "design")
      ensure((await results(page).locator('[data-slot="list-row-main"]').count()) > 0, "Notes search finds no note with “design”")
      await press(app, results(page).locator('[data-slot="list-row-main"]').first())
      ensure(await page.getByRole("region", { name: "Notes: what is open" }).isVisible(), "a found note did not open in Notes")
      // Back to everything, by the key (a phone's open note has no bottom row), with one word several kinds have.
      // Leaving the note's text saves it; that settles first, since a section hidden behind Search stops drawing
      // and a skeleton caught there would stand, unseen, for as long as Search is open.
      await page.evaluate(() => document.activeElement?.blur())
      await app.settle()
      await page.keyboard.press("/")
      await field(page).waitFor()
      await press(app, chips(page).getByRole("radio", { name: /^All/ }))
      await type(app, "design")
      for (const kind of ["Mail", "Calendar", "Contacts", "Notes"]) {
        const n = await results(page).getByRole("region", { name: kind, exact: true }).locator('[data-slot="list-row-main"], [data-slot="calendar-event-title"]').count()
        ensure(n <= 3, `All shows ${n} rows of ${kind}, more than three`)
      }
      ensure((await results(page).getByRole("region").count()) >= 2, "“design” is found in fewer than two kinds")
      await rest(app)
    },
  },
  { name: "command-menu", run: (app) => app.page.keyboard.press("Control+KeyK") },
  { name: "keyboard-shortcuts", run: (app) => app.page.keyboard.press("?") },
]
