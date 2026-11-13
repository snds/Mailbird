// The screens `pnpm shots` takes a picture of. Each scene starts from a fresh
// page on sample data and gets there the way a person would: by the names
// things have on screen. When a screen changes, fix its scene; keep its name,
// so before and after pictures pair up by file name.
//
// A scene is { name, run?, path?, only? }:
//   run(app)   steps from the app's first screen (Mail's inbox). app is
//              { page, phone, settle }: Playwright's page, whether this is the
//              phone size, and a wait until the screen stops changing
//   path       a different address to open ("/?mini")
//   only       "desktop" or "phone", for a screen only one of them has
//
// Text a scene types is the scene's own. Sample data stays in apps/web/src/core/demo*.ts.

/** Clicks, then waits for what it opened to finish arriving, so the next step acts on a still screen. */
const press = async (app, locator) => {
  await locator.click()
  await app.settle()
}
const button = (page, name) => page.getByRole("button", { name, exact: true })

const area = (app, name) => press(app, app.page.getByRole("navigation", { name: "Apps" }).getByRole("button", { name, exact: true }))
const conversation = (app, subject) => press(app, app.page.getByRole("list", { name: "Inbox" }).getByRole("button", { name: subject }).first())
const lane = (app, name) => press(app, app.page.getByRole("tab", { name, exact: true }))
const calendarView = async (app, name) => {
  await area(app, "Calendar")
  await press(app, app.page.getByRole("group", { name: "View" }).getByRole("button", { name, exact: true }))
}
/** The calendars list: beside the grid from tablet up, a sheet behind a button on a phone. */
const calendars = async (app) => {
  await area(app, "Calendar")
  if (app.phone) await press(app, button(app.page, "Calendars"))
}
const newEvent = async (app) => {
  await area(app, "Calendar")
  await press(app, button(app.page, "New event"))
  return app.page.getByRole("dialog", { name: "New event" })
}
const person = async (app, name) => {
  await area(app, "Contacts")
  await press(app, app.page.getByRole("list", { name: "Contacts" }).getByRole("button", { name }))
}
const note = async (app, name) => {
  await area(app, "Notes")
  await press(app, app.page.getByRole("list", { name: "Notes" }).getByRole("button", { name }))
}
const noteAction = async (app, item) => {
  await note(app, /Cabin packing list/)
  await press(app, button(app.page, "Note actions"))
  if (item) await press(app, app.page.getByRole("menuitem", { name: item }))
}
const notesMenu = async (app, item) => {
  await area(app, "Notes")
  await press(app, button(app.page, "More"))
  await press(app, app.page.getByRole("menuitem", { name: item }))
}
const settings = async (app, section) => {
  await press(app, button(app.page, "Accounts and settings"))
  if (section) await press(app, app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }))
}
const compose = async (app) => {
  await press(app, button(app.page, "Compose"))
  return app.page.getByRole("dialog", { name: "New message" })
}
/** A toast that a step raised on its way: wait for it to come and go, so it isn't in the picture by chance. */
const toastGone = async ({ page }) => {
  const toast = page.locator("[data-sonner-toast]").first()
  await toast.waitFor()
  await toast.waitFor({ state: "detached", timeout: 15_000 })
}

export const scenes = [
  // ── Mail ───────────────────────────────────────────────────────────────────
  { name: "mail-inbox" },
  { name: "mail-conversation", run: (app) => conversation(app, /Token audit/) }, // three messages, and the sender beside them
  { name: "mail-invitation", run: (app) => conversation(app, /Invitation: Design crit/) },
  { name: "mail-attachments", run: (app) => conversation(app, /Your booking is confirmed/) },
  { name: "mail-html", run: (app) => conversation(app, /Design Systems Weekly/) }, // an HTML message, remote images held back
  {
    name: "mail-sender",
    only: "phone", // from tablet up, the sender's panel sits beside the conversation
    run: async (app) => {
      await conversation(app, /Token audit/)
      await press(app, app.page.getByRole("button", { name: /^About / }))
    },
  },
  {
    name: "mail-summary", // opt-in AI (ADR-0059): the demo answers for a model on this computer
    run: async (app) => {
      await settings(app, "AI summaries and replies")
      await press(app, app.page.getByRole("radio", { name: /On this computer/ }))
      await app.page.getByRole("combobox", { name: "Model" }).selectOption("llama3.2")
      await area(app, "Mail")
      await conversation(app, /Token audit/)
      await press(app, button(app.page, "Summarize"))
    },
  },
  {
    name: "mail-snooze-menu",
    run: async (app) => {
      await conversation(app, /Token audit/)
      await press(app, button(app.page, "Snooze"))
    },
  },
  {
    name: "mail-archived-toast", // a toast with Undo, taken while it shows
    run: async (app) => {
      await conversation(app, /Cabin weekend/)
      await button(app.page, "Archive").click()
      await app.page.locator("[data-sonner-toast]").first().waitFor()
    },
  },
  {
    name: "mail-attachment-preview",
    run: async (app) => {
      await conversation(app, /Your booking is confirmed/)
      await press(app, app.page.getByRole("button", { name: /what-to-bring\.txt/ }).first())
    },
  },
  {
    name: "mail-unsubscribe",
    run: async (app) => {
      await conversation(app, /Design Systems Weekly/)
      await press(app, button(app.page, "Unsubscribe"))
    },
  },
  {
    name: "mail-share",
    run: async (app) => {
      await conversation(app, /Token audit/)
      await press(app, button(app.page, "Share with teammates"))
    },
  },
  {
    name: "mail-reply",
    run: async (app) => {
      await conversation(app, /Token audit/)
      await press(app, button(app.page, "Reply"))
    },
  },
  {
    name: "mail-compose",
    run: async (app) => {
      const dialog = await compose(app)
      await dialog.getByRole("combobox", { name: "To" }).pressSequentially("Marcus")
      await press(app, dialog.getByRole("option", { name: /Marcus Lee/ }))
      await dialog.getByRole("textbox", { name: "Subject" }).fill("Saturday ferry")
      await dialog.getByRole("textbox", { name: "Message" }).click()
      await app.page.keyboard.type("The 08:15 crossing is booked. Shall we meet at the pier at 7:45?")
    },
  },
  {
    name: "mail-send-later",
    run: async (app) => {
      const dialog = await compose(app)
      await press(app, dialog.getByRole("button", { name: "Send later" }))
    },
  },
  {
    name: "mail-send-later-time",
    run: async (app) => {
      const dialog = await compose(app)
      await press(app, dialog.getByRole("button", { name: "Send later" }))
      await press(app, app.page.getByRole("menuitem", { name: "Pick a time…" }))
    },
  },
  { name: "mail-search", run: (app) => app.page.getByRole("textbox", { name: "Search mail" }).fill("cabin") },
  { name: "mail-search-none", run: (app) => app.page.getByRole("textbox", { name: "Search mail" }).fill("zeppelin") },
  { name: "mail-newsletters", run: (app) => press(app, app.page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Newsletters" })) },
  { name: "mail-split-new", run: (app) => press(app, app.page.getByRole("group", { name: "Show" }).getByRole("button", { name: "New split" })) },
  {
    name: "mail-screener", // the Screener lane shows once screening is on (ADR-0018)
    run: async (app) => {
      await settings(app, "Mail")
      await app.page.getByRole("switch", { name: "Screen first-time senders" }).click()
      await toastGone(app)
      await area(app, "Mail")
      await press(app, app.page.getByRole("tab", { name: /^Screener/ }))
    },
  },
  { name: "mail-unread", run: (app) => lane(app, "Unread") },
  { name: "mail-starred", run: (app) => lane(app, "Starred") },
  {
    name: "mail-snoozed", // nothing is snoozed in the sample data, so the scene snoozes one conversation
    run: async (app) => {
      await conversation(app, /Cabin weekend/)
      await press(app, button(app.page, "Snooze"))
      await app.page.getByRole("menuitem", { name: /^Tomorrow/ }).click()
      await toastGone(app)
      await lane(app, "Snoozed")
    },
  },
  { name: "mail-waiting", run: (app) => lane(app, "Waiting") },
  { name: "mail-scheduled", run: (app) => lane(app, "Scheduled") }, // empty in the sample data: a lane's empty state
  { name: "mail-team", run: (app) => lane(app, "Team") },
  {
    name: "mail-team-open-link",
    run: async (app) => {
      await lane(app, "Team")
      await press(app, app.page.getByRole("button", { name: "Open a link…" }).first())
    },
  },
  { name: "mail-archive", run: (app) => lane(app, "Archive") },

  // ── Calendar ───────────────────────────────────────────────────────────────
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
  { name: "calendar-calendars", only: "phone", run: (app) => calendars(app) }, // from tablet up, the list sits beside the grid
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

  // ── Contacts ───────────────────────────────────────────────────────────────
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

  // ── Notes ──────────────────────────────────────────────────────────────────
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

  // ── Settings ───────────────────────────────────────────────────────────────
  { name: "settings", run: (app) => settings(app) }, // the first section from tablet up, the list of sections on a phone
  { name: "settings-accounts", run: (app) => settings(app, "Accounts") },
  { name: "settings-signatures", run: (app) => settings(app, "Signatures and templates") },
  { name: "settings-mail", run: (app) => settings(app, "Mail") },
  { name: "settings-calendar", run: (app) => settings(app, "Calendar") },
  { name: "settings-shortcuts", run: (app) => settings(app, "Shortcuts and gestures") },
  { name: "settings-ai", run: (app) => settings(app, "AI summaries and replies") },
  { name: "settings-phone", run: (app) => settings(app, "New mail on your phone") },

  // ── Everywhere ─────────────────────────────────────────────────────────────
  { name: "command-menu", run: (app) => app.page.keyboard.press("Control+KeyK") },
  { name: "keyboard-shortcuts", run: (app) => app.page.keyboard.press("?") },

  // ── Other pages ────────────────────────────────────────────────────────────
  { name: "mini-calendar", path: "/?mini" }, // the menu-bar calendar's own small window (ADR-0054)
]
