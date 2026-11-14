// Notes: the list, cards and map, a note and its menu, folders, import, sync and the quick note.
import { area, button, press } from "./helpers.mjs"

/** Opens a note from the Notes list by its title. */
export const note = async (app, name) => {
  await area(app, "Notes")
  await press(app, app.page.getByRole("list", { name: "Notes" }).getByRole("button", { name }))
}
/** Opens the sample checklist's note menu, and one of its items when given. */
export const noteAction = async (app, item) => {
  await note(app, /Cabin packing list/)
  await press(app, button(app.page, "Note actions"))
  if (item) await press(app, app.page.getByRole("menuitem", { name: item }))
}
/** An item from the Notes area's More menu. */
export const notesMenu = async (app, item) => {
  await area(app, "Notes")
  await press(app, button(app.page, "More"))
  await press(app, app.page.getByRole("menuitem", { name: item }))
}

export const scenes = [
  { name: "notes", run: (app) => area(app, "Notes") },
  {
    name: "notes-cards",
    run: async (app) => {
      await area(app, "Notes")
      await press(app, button(app.page, "Show as cards"))
    },
  },
  {
    name: "notes-map",
    run: async (app) => {
      await area(app, "Notes")
      await press(app, button(app.page, "Map of notes"))
    },
  },
  { name: "notes-note", run: (app) => note(app, /Cabin packing list/) }, // a checklist, linked to an event, in a color
  { name: "notes-note-actions", run: (app) => noteAction(app) },
  { name: "notes-share", run: (app) => noteAction(app, "Share…") },
  { name: "notes-lock", run: (app) => noteAction(app, "Lock note") },
  {
    name: "notes-link",
    run: async (app) => {
      await note(app, /Cabin packing list/)
      await press(app, button(app.page, "Link to an event, person, or conversation"))
    },
  },
  {
    name: "notes-sketch",
    run: async (app) => {
      await note(app, /Cabin packing list/)
      await press(app, app.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Sketch" }))
    },
  },
  {
    name: "notes-smart-folder",
    run: async (app) => {
      await area(app, "Notes")
      await press(app, app.page.getByRole("group", { name: "Smart folders" }).getByRole("button", { name: "Smart folder" }))
    },
  },
  { name: "notes-import", run: (app) => notesMenu(app, "Import notes…") },
  { name: "notes-sync", run: (app) => notesMenu(app, "Sync between devices…") },
  { name: "notes-quick-note", run: (app) => app.page.keyboard.press("Alt+KeyN") },
]
