// Settings: the page and each section the demo shows.
import { area, ensure, press, settingsButton } from "./helpers.mjs"

/** Opens Settings, and one section of it when given. Mail's scenes use it too. */
export const settings = async (app, section) => {
  await press(app, settingsButton(app.page))
  if (section) await press(app, app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }))
}

export const scenes = [
  { name: "settings", run: (app) => settings(app) }, // the first section from tablet up, the list of sections on a phone
  { name: "settings-accounts", run: (app) => settings(app, "Accounts") },
  { name: "settings-signatures", run: (app) => settings(app, "Signatures and templates") },
  { name: "settings-mail", run: (app) => settings(app, "Mail") },
  { name: "settings-calendar", run: (app) => settings(app, "Calendar") },
  {
    // The second time zone (ADR-0088; brief T4): a row in Settings › Calendar on the zone picker,
    // "None" first. Picked there, it still adds its column of hours to the calendar's time grid.
    name: "settings-second-zone",
    run: async (app) => {
      const { page } = app
      await settings(app, "Calendar")
      const row = page.getByRole("group", { name: "Second time zone" })
      // (The row cuts a long value in the middle, in two parts: read the text, not the lines.)
      ensure(/None/.test(await row.textContent()), "the row does not start at None")
      await press(app, row.getByRole("button", { name: "Change" }))
      const picker = page.getByRole("dialog", { name: "Second time zone" })
      const options = picker.getByRole("option")
      ensure((await options.first().innerText()).trim().startsWith("None"), "the second zone's list does not start with None")
      ensure(!(await picker.getByRole("option", { name: /Los Angeles/ }).count()), "the second zone's list offers your own zone")
      await picker.getByRole("combobox", { name: "Search time zones" }).fill("lisbon")
      await app.settle()
      await press(app, options.first())
      ensure(/Lisbon \(/.test(await row.textContent()), "the row does not show Lisbon")
      // The time grid's second gutter.
      await area(app, "Calendar")
      await press(app, page.getByRole("group", { name: "View" }).getByRole("button", { name: "Day", exact: true }))
    },
    assert: async ({ page }) => {
      const gutter = page.locator('[data-slot="second-zone"]')
      ensure(await gutter.isVisible(), "the time grid has no second column of hours")
      ensure((await gutter.getAttribute("aria-label")) === "Hours in Lisbon", "the second column is not Lisbon's")
    },
  },
  {
    name: "settings-appearance",
    run: (app) => settings(app, "Appearance"),
    // The row reads the store this harness sets: light is Stone, dark is Graphite (ADR-0082).
    assert: async (app) => {
      const chips = app.page.getByRole("radiogroup", { name: "Theme" })
      ensure((await chips.getByRole("radio").count()) === 3, "the Theme row does not have its three choices")
      const picked = app.theme === "dark" ? "Graphite" : "Stone"
      ensure(await chips.getByRole("radio", { name: picked, exact: true }).isChecked(), `${picked} is not the checked theme`)
    },
  },
  { name: "settings-shortcuts", run: (app) => settings(app, "Shortcuts and gestures") },
  { name: "settings-ai", run: (app) => settings(app, "AI summaries and replies") },
  // "New mail on your phone" until ADR-0085 named it Notifications; the scene keeps its name so its pictures pair up.
  { name: "settings-phone", run: (app) => settings(app, "Notifications") },
]
