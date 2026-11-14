// Calendar: every view, an event and its editor, the calendars list, booking links, and the menu-bar window.
import { area, button, ensure, formLayer, goBack, groups, headTitle, leaveLayer, oneCurrent, pick, press, sidebar, switcherLayer, toastGone } from "./helpers.mjs"
import { settings } from "./settings.mjs"

/** Opens Calendar in one view (Agenda, Day, Week, Month). */
export const calendarView = async (app, name) => {
  await area(app, "Calendar")
  await press(app, app.page.getByRole("group", { name: "View" }).getByRole("button", { name, exact: true }))
}
/** The calendars list: in the sidebar on a desktop, the page head's sheet on a phone (its popover at medium width). Returns it. */
export const calendars = async (app) => {
  await area(app, "Calendar")
  return groups(app)
}
/** Opens a new event; returns its dialog. */
export const newEvent = async (app) => {
  await area(app, "Calendar")
  await press(app, button(app.page, "New event"))
  return app.page.getByRole("dialog", { name: "New event" })
}

export const scenes = [
  { name: "calendar", run: (app) => area(app, "Calendar") }, // opens on the week from tablet up, the agenda on a phone
  { name: "calendar-agenda", run: (app) => calendarView(app, "Agenda") },
  { name: "calendar-day", run: (app) => calendarView(app, "Day") },
  { name: "calendar-week", run: (app) => calendarView(app, "Week") },
  { name: "calendar-month", run: (app) => calendarView(app, "Month") },
  {
    name: "calendar-event",
    run: async (app) => {
      await area(app, "Calendar")
      await press(app, app.page.getByRole("button", { name: /Token audit review/ }).first())
    },
  },
  {
    name: "calendar-event-new",
    run: async (app) => {
      const dialog = await newEvent(app)
      await dialog.getByRole("textbox", { name: "Title" }).fill("Pick up the rental car")
    },
  },
  {
    // An event in the form layer (ADR-0087; brief 3.2): the title as typed in the header, Cancel then Add.
    name: "form-layer-event",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const write = (form) => form.getByRole("textbox", { name: "Title" }).fill("Pick up the rental car")
      await formLayer(app, { open: newEvent, write, primary: "Add" })
      await toastGone(app)
      const form = await newEvent(app)
      await write(form)
      if (!app.phone) ensure(/Pick up the rental car/.test(await form.locator('[data-slot="dialog-title"]').innerText()), "the header does not show the title as typed")
    },
  },
  {
    name: "calendar-find-time",
    run: async (app) => {
      const dialog = await newEvent(app)
      await press(app, dialog.getByRole("button", { name: "Find a time" }))
    },
  },
  {
    name: "calendar-quick-add",
    run: async (app) => {
      await area(app, "Calendar")
      await app.page.getByRole("textbox", { name: "Quick add event" }).fill("Dinner with Marcus Friday 7pm")
    },
  },
  {
    // The calendars to show, sets, and the two tools (ADR-0084; brief X1): the page head's sheet on a
    // phone, its popover at medium width, the sidebar's groups on a desktop.
    name: "calendar-calendars",
    sizes: ["phone", "desktop", "medium"],
    sean: { kind: "undrawn", area: "calendar", screen: "calendars-sheet" },
    run: async (app) => {
      const list = await calendars(app)
      // Toggling a calendar is a filter: the list stays open, and more than one may change.
      const holidays = list.getByRole("checkbox", { name: /^Holidays/ })
      await press(app, holidays)
      ensure(!(await holidays.isChecked()), "the calendar did not hide")
      ensure(await list.isVisible(), "toggling a calendar closed the list")
      await press(app, holidays)
      ensure(await holidays.isChecked(), "the calendar did not show again")
    },
    assert: async (app) => {
      const { page } = app
      const list = await groups(app)
      for (const row of ["Tasks", "Booking links", "Save as set…"]) ensure(await list.getByRole("button", { name: row, exact: true }).count(), `${row} is not in the calendars list`)
      ensure(await list.getByRole("button", { name: "Add calendars", exact: true }).count(), "the first group has no Add calendars action")
      ensure(!(await list.locator('[role="checkbox"][aria-current]').count()), "a calendar says it is the current place: it is a filter")
      // One current place: the calendar itself, which the sidebar names under Apps and the layer in its own list.
      ensure((await oneCurrent((await switcherLayer(page).count()) ? list : sidebar(page), "the calendars list")) === "Calendar", "Calendar is not the current place")
      // What left the calendar's side list is still on the screen behind: quick add, and the month from tablet up.
      // (Found by attribute: an open sheet hides the page behind it from roles.)
      ensure(await page.locator('input[aria-label="Quick add event"]').count(), "Quick add is gone")
      if (!app.phone) ensure(await page.locator('aside[aria-label="Go to a date"] [role="grid"]').count(), "the mini month is gone")
    },
  },
  {
    name: "calendar-add-calendars",
    run: async (app) => {
      const list = await calendars(app)
      await press(app, list.getByRole("button", { name: "Add calendars", exact: true }))
    },
  },
  {
    name: "calendar-plan-task",
    run: async (app) => {
      await area(app, "Calendar")
      await pick(app, "Tasks")
      await press(app, button(app.page, "Plan: Board games"))
    },
  },
  {
    name: "calendar-booking-link",
    run: async (app) => {
      await area(app, "Calendar")
      await pick(app, "Booking links")
      await press(app, button(app.page, "New booking link"))
      await app.page.getByRole("dialog", { name: "New booking link" }).getByRole("textbox", { name: "Title" }).fill("Intro call")
    },
  },
  {
    name: "calendar-booking-page", // the public booking page (ADR-0026), as the demo previews it
    run: async (app) => {
      await area(app, "Calendar")
      await pick(app, "Booking links")
      await press(app, button(app.page, "New booking link"))
      const form = app.page.getByRole("dialog", { name: "New booking link" })
      await form.getByRole("textbox", { name: "Title" }).fill("Intro call")
      await form.getByRole("button", { name: "Add link" }).click()
      await toastGone(app)
      await press(app, button(app.page, "Preview Intro call"))
    },
  },
  {
    // Tasks is a place of its own (ADR-0084; brief C6): today's panel in the list column, the screen on a phone.
    name: "places-tasks",
    sizes: ["phone", "desktop", "medium"],
    run: async (app) => {
      await area(app, "Calendar")
      await pick(app, "Tasks")
    },
    assert: async (app) => {
      const { page } = app
      ensure(await page.getByRole("region", { name: "Tasks" }).first().isVisible(), "the Tasks panel is not showing")
      ensure(await button(page, "Plan: Board games").first().isVisible(), "a task cannot be planned from here")
      if (app.phone) ensure((await headTitle(page)) === "Tasks", "the phone's page head does not name Tasks")
      if (await sidebar(page).locator('[aria-label="Tasks"]').count()) ensure((await oneCurrent(sidebar(page), "the sidebar")) === "Tasks", "Tasks is not the sidebar's current place")
      else ensure((await oneCurrent(await groups(app), "the calendars list")) === "Tasks", "Tasks is not the current place")
      if (await switcherLayer(page).count()) await leaveLayer(app)
      // Back is the calendar again.
      await goBack(app)
      ensure(!(await page.getByRole("region", { name: "Tasks" }).count()), "Back from Tasks did not return to the calendar")
      await page.goForward()
      await app.settle()
    },
  },
  {
    // Booking links, a place too (brief C7). On the way: the second time zone, which left the
    // calendar's side list for Settings › Calendar.
    name: "places-booking-links",
    sizes: ["phone", "desktop", "medium"],
    run: async (app) => {
      await settings(app, "Calendar")
      ensure(await app.page.getByRole("combobox", { name: "Second time zone" }).isVisible(), "Settings › Calendar has no second time zone")
      await area(app, "Calendar")
      await pick(app, "Booking links")
    },
    assert: async (app) => {
      const { page } = app
      ensure(await page.getByRole("region", { name: "Booking links" }).first().isVisible(), "the Booking links panel is not showing")
      ensure(await button(page, "New booking link").first().isVisible(), "a booking link cannot be made from here")
      if (await sidebar(page).locator('[aria-label="Booking links"]').count()) ensure((await oneCurrent(sidebar(page), "the sidebar")) === "Booking links", "Booking links is not the sidebar's current place")
    },
  },
  { name: "mini-calendar", path: "/?mini" }, // the menu-bar calendar's own small window (ADR-0054)
]
