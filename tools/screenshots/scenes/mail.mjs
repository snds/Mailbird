// Mail: the lanes, a conversation, reading and writing. Search is in search.mjs.
import { area, button, press, toastGone } from "./helpers.mjs"
import { settings } from "./settings.mjs"

/** Opens a conversation in the Inbox list by its subject. */
export const conversation = (app, subject) => press(app, app.page.getByRole("list", { name: "Inbox" }).getByRole("button", { name: subject }).first())
/** Opens a lane (Unread, Starred, Snoozed…) by its tab. */
export const lane = (app, name) => press(app, app.page.getByRole("tab", { name, exact: true }))
/** Opens a new message; returns its dialog. */
export const compose = async (app) => {
  await press(app, button(app.page, "Compose"))
  return app.page.getByRole("dialog", { name: "New message" })
}

export const scenes = [
  { name: "mail-inbox" },
  { name: "mail-conversation", run: (app) => conversation(app, /Token audit/) }, // three messages, and the sender beside them
  { name: "mail-invitation", run: (app) => conversation(app, /Invitation: Design crit/) },
  { name: "mail-attachments", run: (app) => conversation(app, /Your booking is confirmed/) },
  { name: "mail-html", run: (app) => conversation(app, /Design Systems Weekly/) }, // an HTML message, remote images held back
  {
    name: "mail-sender",
    sizes: ["phone"], // from tablet up, the sender's panel sits beside the conversation
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
]
