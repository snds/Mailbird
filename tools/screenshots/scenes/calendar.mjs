// Calendar: every view, an event and its editor, the calendars list, booking links, and the menu-bar window.
import { area, button, press, toastGone } from "./helpers.mjs"

/** Opens Calendar in one view (Agenda, Day, Week, Month). */
export const calendarView = async (app, name) => {
  await area(app, "Calendar")
  await press(app, app.page.getByRole("group", { name: "View" }).getByRole("button", { name, exact: true }))
}
/** The calendars list: beside the grid from tablet up, a sheet behind a button on a phone. */
export const calendars = async (app) => {
  await area(app, "Calendar")
  if (app.phone) await press(app, button(app.page, "Calendars"))
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
  { name: "calendar-calendars", sizes: ["phone"], run: (app) => calendars(app) }, // from tablet up, the list sits beside the grid
  {
    name: "calendar-add-calendars",
    run: async (app) => {
      await calendars(app)
      await press(app, button(app.page, "Add holidays and more"))
    },
  },
  {
    name: "calendar-plan-task",
    run: async (app) => {
      await calendars(app)
      await press(app, button(app.page, "Plan: Board games"))
    },
  },
  {
    name: "calendar-booking-link",
    run: async (app) => {
      await calendars(app)
      await press(app, button(app.page, "New booking link"))
      await app.page.getByRole("dialog", { name: "New booking link" }).getByRole("textbox", { name: "Title" }).fill("Intro call")
    },
  },
  {
    name: "calendar-booking-page", // the public booking page (ADR-0026), as the demo previews it
    run: async (app) => {
      await calendars(app)
      await press(app, button(app.page, "New booking link"))
      const form = app.page.getByRole("dialog", { name: "New booking link" })
      await form.getByRole("textbox", { name: "Title" }).fill("Intro call")
      await form.getByRole("button", { name: "Add link" }).click()
      await toastGone(app)
      await press(app, button(app.page, "Preview Intro call"))
    },
  },
  { name: "mini-calendar", path: "/?mini" }, // the menu-bar calendar's own small window (ADR-0054)
]
