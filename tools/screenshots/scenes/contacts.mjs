// Contacts: the list, a person, editing, groups, sharing, duplicates and restore.
import { area, button, ensure, goBack, groups, headTitle, leaveLayer, oneCurrent, pick, press, sidebar, switcherLayer } from "./helpers.mjs"

/** Opens a person from the Contacts list by name. */
export const person = async (app, name) => {
  await area(app, "Contacts")
  await press(app, app.page.getByRole("list", { name: "Contacts" }).getByRole("button", { name }))
}

export const scenes = [
  { name: "contacts", run: (app) => area(app, "Contacts") },
  { name: "contacts-person", run: (app) => person(app, /Priya Raman/) },
  {
    name: "contacts-edit",
    run: async (app) => {
      await person(app, /Priya Raman/)
      await press(app, button(app.page, "Edit"))
    },
  },
  {
    name: "contacts-new",
    run: async (app) => {
      await area(app, "Contacts")
      await press(app, button(app.page, "New contact"))
    },
  },
  {
    name: "contacts-share",
    run: async (app) => {
      await person(app, /Priya Raman/)
      await press(app, button(app.page, "Share"))
    },
  },
  {
    name: "contacts-duplicates",
    run: async (app) => {
      await area(app, "Contacts")
      await press(app, app.page.getByRole("button", { name: /possible duplicate/ }))
    },
  },
  {
    name: "contacts-restore",
    run: async (app) => {
      await area(app, "Contacts")
      await pick(app, "Restore contacts")
    },
  },
  {
    name: "contacts-smart-group",
    run: async (app) => {
      await area(app, "Contacts")
      await pick(app, "New smart group…")
    },
  },
  {
    // Contacts' groups and clean-up tools (ADR-0084; brief X1): the page head's sheet on a phone, its
    // popover at medium width, the sidebar's groups on a desktop.
    name: "contacts-groups-sheet",
    sizes: ["phone", "desktop", "medium"],
    sean: { kind: "undrawn", area: "contacts", screen: "groups-sheet" },
    run: async (app) => {
      const { page } = app
      await area(app, "Contacts")
      // A label is a place: it opens from its row, and Back is everyone again.
      await pick(app, "Work")
      ensure((await headTitle(page)) === "Work", "the Work label did not open from the groups")
      await goBack(app)
      ensure((await headTitle(page)) === "People", "Back from a label did not return to everyone")
      // Restore contacts opens through its intent; the layer closes first.
      await pick(app, "Restore contacts")
      ensure(await page.getByRole("dialog", { name: "Restore contacts" }).isVisible(), "Restore contacts did not open")
      ensure(!(await switcherLayer(page).count()), "the layer stayed open under the form")
      await leaveLayer(app)
      await groups(app)
    },
    assert: async (app) => {
      const list = await groups(app)
      ensure((await oneCurrent(list, "Contacts' groups")).startsWith("All contacts"), "All contacts is not the current place")
      for (const row of ["Duplicates", "Recently deleted", "Restore contacts", "New smart group…"]) ensure(await list.locator(`[aria-label="${row}"], [aria-label^="${row}, "]`).count(), `${row} is not in Contacts' groups`)
    },
  },
  {
    // Duplicates is a place (brief P4): today's pane, with the list's room.
    name: "places-duplicates",
    sizes: ["phone", "desktop", "medium"],
    run: async (app) => {
      await area(app, "Contacts")
      await pick(app, "Duplicates")
    },
    assert: async (app) => {
      const { page } = app
      ensure((await headTitle(page)) === "Duplicates", "the page head does not name Duplicates")
      ensure(await button(page, "Merge").first().isVisible(), "the duplicates cannot be merged from here")
      ensure((await oneCurrent(await groups(app), "Contacts' groups")).startsWith("Duplicates"), "Duplicates is not the current place")
      if (await switcherLayer(page).count()) await leaveLayer(app)
      await goBack(app)
      ensure((await headTitle(page)) === "People", "Back from Duplicates did not return to everyone")
      await page.goForward()
      await app.settle()
    },
  },
  {
    // Recently deleted is a place (brief P5): today's pane, with the list's room. Nothing is deleted in the sample data.
    name: "places-recently-deleted",
    sizes: ["phone", "desktop", "medium"],
    run: async (app) => {
      await area(app, "Contacts")
      await pick(app, "Recently deleted")
    },
    assert: async (app) => {
      const { page } = app
      ensure((await headTitle(page)) === "Recently deleted", "the page head does not name Recently deleted")
      ensure(await page.getByRole("region", { name: "Recently deleted" }).isVisible(), "the Recently deleted pane is not showing")
      ensure((await oneCurrent(await groups(app), "Contacts' groups")) === "Recently deleted", "Recently deleted is not the current place")
      if (await switcherLayer(page).count()) await leaveLayer(app)
    },
  },
]
