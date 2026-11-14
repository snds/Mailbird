// Contacts: the list, a person, editing, groups, sharing, duplicates and restore.
import { area, button, press } from "./helpers.mjs"

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
      await press(app, button(app.page, "Restore contacts"))
    },
  },
  {
    name: "contacts-smart-group",
    run: async (app) => {
      await area(app, "Contacts")
      await press(app, app.page.getByRole("group", { name: "Smart groups" }).getByRole("button", { name: "Smart group" }))
    },
  },
]
