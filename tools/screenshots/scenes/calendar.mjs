// Calendar: every view, an event and its editor, the calendars list, booking links, and the menu-bar window.
import { area, button, ensure, formLayer, goBack, groups, headTitle, leaveLayer, oneCurrent, pick, press, sidebar, switcherLayer, toastGone } from "./helpers.mjs"
import { compose } from "./mail.mjs"
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
      ensure(await app.page.getByRole("group", { name: "Second time zone" }).isVisible(), "Settings › Calendar has no second time zone")
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
  {
    // The menu-bar calendar's own small window (ADR-0054). Its month is the shared month grid (ADR-0088).
    name: "mini-calendar",
    path: "/?mini",
    assert: async ({ page }) => {
      const grid = page.getByRole("grid", { name: "November 2026" })
      ensure(await grid.getByRole("gridcell", { name: /^Thursday, November 12, today, \d+ events?$/ }).getAttribute("aria-selected") === "true", "today is not the picked day, named with its events")
      ensure((await grid.getByRole("gridcell").count()) === 42, "the month is not six weeks")
    },
  },
  {
    // The date-and-time picker and the month grid's keys (ADR-0088; briefs M8 and C3), from the
    // composer's Send later: a popover on a desktop, a sheet on a phone. It ends on Friday the 20th
    // picked, so the picture shows the block, and today's edge under the 12th.
    name: "picker-keys",
    sean: { kind: "undrawn", area: "mail", screen: "pick-date-time" },
    run: async (app) => {
      const { page } = app
      const message = await compose(app)
      const open = async () => {
        // (Held as an element: an open menu hides the form behind it from roles.)
        const later = await message.getByRole("button", { name: "Send later" }).elementHandle()
        await later.click()
        await app.settle()
        // The one button opens the menu and anchors the picker: it says the menu's state, not the picker's.
        ensure((await later.getAttribute("aria-expanded")) === "true" && (await later.getAttribute("aria-haspopup")) === "menu", "Send later does not say its menu is open")
        await press(app, page.getByRole("menuitem", { name: "Pick a time…" }))
        ensure((await later.getAttribute("aria-expanded")) === "false", "Send later says its menu is open under the picker")
        return page.getByRole("dialog", { name: "Send later" })
      }
      let picker = await open()
      // Esc closes the picker, and only the picker.
      await page.keyboard.press("Escape")
      await app.settle()
      ensure(!(await picker.count()), "Esc did not close the picker")
      ensure(await message.isVisible(), "Esc in the picker closed the message too")
      picker = await open()
      const box = await picker.boundingBox()
      if (app.phone) ensure(Math.round(box.width) === app.viewport.width && Math.round(box.y + box.height) === app.viewport.height, "on a phone the picker is not a sheet at the foot")
      else ensure(Math.round(box.width) === 320, `the picker's popover is ${Math.round(box.width)} wide, not 320`)
      const focused = () => page.evaluate(() => `${document.activeElement?.getAttribute("role")}: ${document.activeElement?.getAttribute("aria-label")}`)
      const grid = (month) => picker.getByRole("grid", { name: month })
      const day = (name) => picker.getByRole("gridcell", { name })
      // It opens on the picked day: today.
      ensure(/^gridcell: Thursday, November 12/.test(await focused()), `the picker opened on "${await focused()}", not on its day`)
      ensure((await day(/^Thursday, November 12/).getAttribute("aria-selected")) === "true", "today is not the picked day")
      ensure((await day(/^Thursday, November 12/).getAttribute("aria-current")) === "date", "today is not marked as today")
      // Arrows move a day, and a week.
      await page.keyboard.press("ArrowRight")
      ensure(/November 13/.test(await focused()), `ArrowRight went to "${await focused()}"`)
      await page.keyboard.press("ArrowDown")
      ensure(/November 20/.test(await focused()), `ArrowDown went to "${await focused()}"`)
      ensure((await day(/^Thursday, November 12/).getAttribute("aria-selected")) === "true", "moving with the arrows picked a day")
      // Enter picks.
      await page.keyboard.press("Enter")
      ensure((await day(/^Friday, November 20/).getAttribute("aria-selected")) === "true", "Enter did not pick the day")
      ensure(await picker.isVisible(), "Enter in the grid closed the picker")
      // Page Down and Page Up move a month; the grid is named for it.
      await page.keyboard.press("PageDown")
      await app.settle()
      ensure(await grid("December 2026").isVisible(), "Page Down did not show December")
      ensure(/December 20/.test(await focused()), `Page Down went to "${await focused()}"`)
      await page.keyboard.press("PageUp")
      await app.settle()
      ensure(await grid("November 2026").isVisible(), "Page Up did not return to November")
      // Home and End: the week's ends.
      await page.keyboard.press("Home")
      ensure(/Sunday, November 15/.test(await focused()), `Home went to "${await focused()}"`)
      await page.keyboard.press("End")
      ensure(/Saturday, November 21/.test(await focused()), `End went to "${await focused()}"`)
      // An arrow off the month's edge shows the next month.
      for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowDown")
      await app.settle()
      ensure(await grid("December 2026").isVisible() && /December 5/.test(await focused()), `two weeks down went to "${await focused()}"`)
      // The paging buttons.
      await press(app, picker.getByRole("button", { name: "Previous month" }))
      ensure(await grid("November 2026").isVisible(), "Previous month did not return to November")
      // A time in the past is the field's error, and the primary does not schedule.
      const error = picker.getByText("Pick a time at least a minute from now.")
      ensure(!(await error.count()), "the picker shows the error before a past time is picked")
      await press(app, day(/^Wednesday, November 11/))
      ensure(await error.isVisible(), "a past time shows no error")
      ensure((await picker.getByRole("textbox", { name: "Time" }).getAttribute("aria-invalid")) === "true", "the Time field is not marked invalid")
      await press(app, picker.getByRole("button", { name: "Schedule", exact: true }))
      ensure(await picker.isVisible(), "a past time was scheduled")
      // Back on a day ahead, the error goes.
      await press(app, day(/^Friday, November 20/))
      ensure(!(await error.count()), "the error stayed after a day ahead was picked")
      await page.mouse.move(0, 0)
    },
    assert: async ({ page }) => {
      const picker = page.getByRole("dialog", { name: "Send later" })
      ensure((await picker.getByRole("button", { name: "Schedule", exact: true }).count()) === 1, "the picker does not have its one primary")
      ensure((await picker.getByRole("gridcell").count()) === 42, "the month is not six weeks")
      ensure((await picker.getByRole("columnheader").count()) === 7, "the month has no weekday initials")
    },
  },
  {
    // The time-zone picker (ADR-0088; brief C3), from a new event: "Yours" first, found by typing.
    name: "zone-picker",
    run: async (app) => {
      const { page } = app
      const form = await newEvent(app)
      const open = async () => {
        await press(app, form.getByRole("button", { name: "Change time zone" }))
        return page.getByRole("dialog", { name: "Time zone" })
      }
      let picker = await open()
      const options = picker.getByRole("option")
      ensure(/^Yours \/\/ Los Angeles/.test((await options.first().innerText()).trim()), `the first zone is "${await options.first().innerText()}", not yours`)
      const all = await options.count()
      ensure(all > 300, `the list has ${all} zones`)
      const search = picker.getByRole("combobox", { name: "Search time zones" })
      await search.fill("lisb")
      await app.settle()
      const found = await options.allInnerTexts()
      ensure(found.length === 1 && /^Lisbon/.test(found[0].trim()), `"lisb" found: ${found.join(" | ")}`)
      // By short name too, and by region.
      await search.fill("PST")
      await app.settle()
      ensure(/^Yours/.test((await options.first().innerText()).trim()), "your zone is not found by its short name")
      await search.fill("europe")
      await app.settle()
      ensure((await options.count()) > 20 && (await options.count()) < all, `"europe" found ${await options.count()} zones`)
      await search.fill("zzzz")
      await app.settle()
      ensure(await picker.getByText("No time zone like that.").isVisible(), "nothing found says nothing")
      await search.fill("lisbon")
      await app.settle()
      await press(app, options.first())
      ensure(!(await picker.count()), "picking a zone did not close the picker")
      ensure(/^Lisbon \(/.test((await form.locator('[data-slot="event-zone"]').innerText()).trim()), "the event does not show Lisbon")
      ensure(/your time \(Los Angeles\)/.test(await form.locator('[data-slot="zone-note"]').innerText()), "the event does not say what that is on your clock")
      // The picture: the list open again, narrowed, with the picked zone marked.
      picker = await open()
      await picker.getByRole("combobox", { name: "Search time zones" }).fill("lis")
      await app.settle()
    },
  },
]
