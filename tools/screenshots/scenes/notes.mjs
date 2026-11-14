// Notes: the list, cards and map, a note and its menu, folders, import, sync and the quick note.
import { area, button, ensure, formLayer, goBack, groups, headTitle, leaveLayer, oneCurrent, pick, press, sidebar, switcherLayer } from "./helpers.mjs"

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
  {
    // A reminder at any date and time (ADR-0088; brief N2): the shared picker from the note's bell.
    name: "notes-remind-time",
    run: async (app) => {
      await note(app, /Cabin packing list/)
      await press(app, button(app.page, "Remind me"))
      await press(app, app.page.getByRole("menuitem", { name: "Pick a date and time…" }))
      const picker = app.page.getByRole("dialog", { name: "Remind me" })
      await press(app, picker.getByRole("gridcell", { name: /^Friday, November 13/ }))
      await press(app, picker.getByRole("button", { name: "Set reminder", exact: true }))
      ensure(!(await picker.count()), "Set reminder did not close the picker")
      // The bell now says when; the picker opens from it again.
      await press(app, app.page.getByRole("button", { name: /^Reminder: Tomorrow, 11:00/ }))
      await press(app, app.page.getByRole("menuitem", { name: "Pick a date and time…" }))
      await app.page.mouse.move(0, 0)
    },
    assert: async ({ page }) => {
      const picker = page.getByRole("dialog", { name: "Remind me" })
      ensure(await picker.getByRole("button", { name: "Set reminder", exact: true }).isVisible(), "the reminder picker has no Set reminder button")
      ensure((await picker.getByRole("gridcell", { name: /^Friday, November 13/ }).getAttribute("aria-selected")) === "true", "the picker did not open on the reminder already set")
    },
  },
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
      await pick(app, "New smart folder…")
    },
  },
  {
    // A smart folder in the form layer (ADR-0087).
    name: "form-layer-smart-folder",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const { page } = app
      const open = async () => {
        await area(app, "Notes")
        await pick(app, "New smart folder…")
        return page.getByRole("dialog", { name: "New smart folder" })
      }
      // A folder needs a rule as well as a name.
      const write = async (form) => {
        await form.getByRole("textbox", { name: "Contains the words" }).fill("agenda")
        await form.getByRole("textbox", { name: "Name" }).fill("This week")
      }
      await formLayer(app, { open, write, primary: "Add folder" })
      const toast = page.locator("[data-sonner-toast]").first()
      await toast.waitFor()
      await page.mouse.move(0, 0)
      await toast.waitFor({ state: "detached", timeout: 15_000 })
      await write(await open())
    },
  },
  { name: "notes-import", run: (app) => notesMenu(app, "Import notes…") },
  { name: "notes-sync", run: (app) => notesMenu(app, "Sync between devices…") },
  { name: "notes-quick-note", run: (app) => app.page.keyboard.press("Alt+KeyN") },
  {
    // Notes' folders and tags (ADR-0084; brief X1): the page head's sheet on a phone, with the view
    // choice as its last group; its popover at medium width; the sidebar's groups on a desktop.
    name: "notes-folders-sheet",
    sizes: ["phone", "desktop", "medium"],
    sean: { kind: "undrawn", area: "notes", screen: "folders-sheet" },
    run: async (app) => {
      const { page } = app
      await area(app, "Notes")
      // A folder is a place: Pinned opens from its row, and Back is all notes again.
      await pick(app, "Pinned")
      ensure((await headTitle(page)) === "Pinned", "Pinned did not open from the folders")
      await goBack(app)
      ensure((await headTitle(page)) === "Notes", "Back from Pinned did not return to all notes")
      // A tag narrows the open folder, one at a time, and clears on a second pick.
      const tag = async () => (await groups(app)).getByRole("checkbox").first()
      const name = await (await tag()).getAttribute("aria-label")
      await press(app, await tag())
      ensure(await (await tag()).isChecked(), `${name} did not narrow the folder`)
      ensure((await page.locator('[data-slot="page-head-overline"]:visible').first().innerText()).toLowerCase().includes(name.toLowerCase()), "the page head does not name the tag")
      await press(app, await tag())
      ensure(!(await (await tag()).isChecked()), `${name} did not clear on a second pick`)
      // "Open a shared note…" opens through its intent; the layer closes first.
      await pick(app, "Open a shared note…")
      ensure(await page.getByRole("dialog", { name: "Open a shared note" }).isVisible(), "Open a shared note did not open")
      ensure(!(await switcherLayer(page).count()), "the layer stayed open under the form")
      await leaveLayer(app)
      await groups(app)
    },
    assert: async (app) => {
      const { page } = app
      const list = await groups(app)
      ensure((await oneCurrent(list, "Notes' folders")) === "All notes", "All notes is not the current place")
      for (const row of ["Pinned", "Archive", "New smart folder…", "Open a shared note…"]) ensure(await list.getByRole("button", { name: row, exact: true }).count(), `${row} is not in Notes' folders`)
      ensure(!(await list.locator('[role="checkbox"][aria-current]').count()), "a tag says it is the current place: it is a filter")
      // The phone's sheet ends with how the notes are drawn; elsewhere the page head keeps that choice.
      const view = list.getByRole("radiogroup", { name: "View" })
      if (app.size === "phone") ensure(await view.getByRole("radio", { name: "List", exact: true }).isChecked(), "the sheet does not end with the view choice, on List")
      else ensure(!(await view.count()), "the view choice is in the list, and it is the phone sheet's alone")
      ensure(!(await page.getByRole("menuitem").count()), "a menu is open under the list")
    },
  },
]
