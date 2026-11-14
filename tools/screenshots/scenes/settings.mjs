// Settings: the page and each section the demo shows.
import { button, ensure, press } from "./helpers.mjs"

/** Opens Settings, and one section of it when given. Mail's scenes use it too. */
export const settings = async (app, section) => {
  await press(app, button(app.page, "Accounts and settings"))
  if (section) await press(app, app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }))
}

export const scenes = [
  { name: "settings", run: (app) => settings(app) }, // the first section from tablet up, the list of sections on a phone
  { name: "settings-accounts", run: (app) => settings(app, "Accounts") },
  { name: "settings-signatures", run: (app) => settings(app, "Signatures and templates") },
  { name: "settings-mail", run: (app) => settings(app, "Mail") },
  { name: "settings-calendar", run: (app) => settings(app, "Calendar") },
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
  { name: "settings-phone", run: (app) => settings(app, "New mail on your phone") },
]
