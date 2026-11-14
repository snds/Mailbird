// Mail: the lanes, a conversation, reading and writing. Search is in search.mjs.
import { area, button, closeForm, discardQuestion, ensure, formLayer, goBack, groups, headTitle, leaveLayer, oneCurrent, pick, press, switcher, switcherLayer, toastGone } from "./helpers.mjs"
import { settings } from "./settings.mjs"

/** Opens a conversation in the Inbox list by its subject. */
export const conversation = (app, subject) => press(app, app.page.getByRole("list", { name: "Inbox" }).getByRole("button", { name: subject }).first())
/** Opens a lane (Unread, Starred, Snoozed…) from Mail's folders: the sidebar, or the page head's sheet or popover. */
export const lane = (app, name) => pick(app, name)
/** Opens a new message; returns its dialog. */
export const compose = async (app) => {
  await press(app, button(app.page, "Compose"))
  return app.page.getByRole("dialog", { name: "New message" })
}

/** Writes a message to Marcus and sends it. */
export const send = async (app, subject) => {
  const message = await compose(app)
  await message.getByRole("combobox", { name: "To" }).pressSequentially("Marcus")
  await press(app, message.getByRole("option", { name: /Marcus Lee/ }))
  await message.getByRole("textbox", { name: "Subject" }).fill(subject)
  await press(app, message.getByRole("button", { name: "Send", exact: true }))
  await message.waitFor({ state: "detached" })
  await app.settle()
}
const toasts = (page) => page.locator("[data-sonner-toast]")
const visibleBoxes = async (list) => {
  const boxes = []
  for (const el of await list.all()) if (await el.isVisible()) boxes.push(await el.boundingBox())
  return boxes.filter(Boolean)
}
/** The bars at the phone's foot: the bottom row, a strip above it, a toast in the strip's slot. */
const bars = async (page) => 1 + ((await page.locator('[data-slot="accessory"]:not([data-compact]):visible').count()) ? 1 : 0) + (await visibleBoxes(page.locator("[data-sonner-toast]"))).filter((b) => b.y > 422).length
const strip = (page) => page.locator('[data-slot="accessory"]')
/** Archives a conversation from its own action bar: a finished action, so a toast with Undo. */
const archive = async (app, subject) => {
  await conversation(app, subject)
  // The conversation's own action: Mail's folders have an Archive too, in the sidebar (ADR-0084).
  await app.page.getByRole("region", { name: "Mail: what is open" }).getByRole("button", { name: "Archive", exact: true }).click()
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
    // The presets, then any date and time (ADR-0088; brief M8).
    assert: async ({ page }) => ensure(await page.getByRole("menuitem", { name: "Pick date and time…" }).isVisible(), "the snooze menu has no custom time"),
  },
  {
    // Snooze until any date and time: the shared picker, titled for the job, with its one primary.
    name: "mail-snooze-time",
    run: async (app) => {
      await conversation(app, /Token audit/)
      await press(app, button(app.page, "Snooze"))
      await press(app, app.page.getByRole("menuitem", { name: "Pick date and time…" }))
      const picker = app.page.getByRole("dialog", { name: "Snooze" })
      // Tomorrow, at the hour it opens on: the conversation leaves the inbox until then.
      await press(app, picker.getByRole("gridcell", { name: /^Friday, November 13/ }))
      await press(app, picker.getByRole("button", { name: "Snooze", exact: true }))
      ensure(!(await picker.count()), "Snooze did not close the picker")
      await toasts(app.page).filter({ hasText: /Snoozed/ }).first().waitFor()
      await toastGone(app)
      // The picture: the picker again, on another conversation.
      await conversation(app, /Cabin weekend/)
      await press(app, button(app.page, "Snooze"))
      await press(app, app.page.getByRole("menuitem", { name: "Pick date and time…" }))
      await app.page.mouse.move(0, 0)
    },
    assert: async ({ page }) => ensure(await page.getByRole("dialog", { name: "Snooze" }).getByRole("button", { name: "Snooze", exact: true }).isVisible(), "the snooze picker has no Snooze button"),
  },
  {
    name: "mail-archived-toast", // a toast with Undo, taken while it shows
    run: async (app) => {
      await archive(app, /Cabin weekend/)
      await toasts(app.page).first().waitFor()
    },
  },
  {
    // Where a toast stands (ADR-0086; cross-app decisions §1): the bottom left of the content on a
    // desktop; on a phone the status strip's slot, so the foot never holds three bars, and never
    // over a strip with an action: it waits for a send's undo window to end.
    name: "toast-placement",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const { page } = app
      if (app.phone) {
        await send(app, "Saturday ferry")
        await archive(app, /Cabin weekend/)
        await app.settle()
        await page.waitForTimeout(600)
        ensure(await strip(page).getByRole("button", { name: "Undo", exact: true }).isVisible(), "the sending strip left for a toast")
        const held = await strip(page).boundingBox()
        for (const box of await visibleBoxes(toasts(page))) ensure(box.y + box.height <= held.y || box.y >= held.y + held.height, "a toast covers the sending strip")
        ensure((await bars(page)) <= 2, `the foot holds ${await bars(page)} bars`)
        // The send is taken back, so the slot is free and the toast that waited takes it.
        await press(app, strip(page).getByRole("button", { name: "Undo", exact: true }))
        // The message is back with its recipient and subject, so closing it asks first (ADR-0087).
        await closeForm(app)
      } else await archive(app, /Cabin weekend/)
      await toasts(page).filter({ hasText: "Archived" }).first().waitFor()
      await page.mouse.move(0, 0)
    },
    assert: async (app) => {
      const { page } = app
      const toast = toasts(page).filter({ hasText: "Archived" }).first()
      const box = await toast.boundingBox()
      ensure(await toast.getByRole("button", { name: "Undo", exact: true }).isVisible(), "the toast has no Undo")
      ensure((await toast.getByRole("button").count()) === 1, "the toast holds more than one action")
      if (app.phone) {
        const row = await page.locator('[data-slot="app-frame-bottom-row-bar"]').boundingBox()
        ensure(!(await strip(page).isVisible()), "a strip and a toast both stand above the bottom row")
        ensure(box.y + box.height <= row.y && row.y - (box.y + box.height) <= 16, `the toast is not in the strip's slot: it ends at ${Math.round(box.y + box.height)}, the row starts at ${Math.round(row.y)}`)
        ensure(Math.round(box.x) === 16 && Math.round(box.x + box.width) === app.viewport.width - 16, `the toast spans ${Math.round(box.x)} to ${Math.round(box.x + box.width)}`)
        ensure((await bars(page)) === 2, `the foot holds ${await bars(page)} bars`)
      } else {
        const content = await page.locator('[data-slot="app-frame-status-line"]').boundingBox()
        ensure(Math.abs(box.x - content.x) <= 1, `the toast starts at ${Math.round(box.x)}, the content at ${Math.round(content.x)}`)
        ensure(app.viewport.height - (box.y + box.height) <= 48, "the toast is not at the bottom")
        ensure(box.x + box.width / 2 < content.x + content.width / 2, "the toast is not at the left of the content")
      }
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
      await app.page.mouse.move(0, 0)
    },
  },
  {
    // "Discard changes?" (ADR-0087; brief X6): a message asks whenever it holds a recipient, a subject,
    // text or a file, one reopened by Undo send too. KEEP EDITING is the no and takes focus.
    name: "discard-question",
    sean: { kind: "undrawn", area: "shell", screen: "discard-question" },
    run: async (app) => {
      const { page } = app
      const question = discardQuestion(page)
      const message = page.getByRole("dialog", { name: "New message" })
      const discard = question.getByRole("button", { name: "Discard", exact: true })
      const keep = question.getByRole("button", { name: "Keep editing", exact: true })
      const esc = async () => {
        await page.keyboard.press("Escape")
        await app.settle()
      }
      // Empty, it closes at once: the signature alone is not writing.
      await compose(app)
      await esc()
      ensure(!(await question.count()), "an empty message asked before closing")
      ensure(!(await message.count()), "Esc did not close an empty message")
      // With text, Esc asks. Focus starts on KEEP EDITING, so Enter never discards by accident.
      await compose(app)
      await message.getByRole("textbox", { name: "Message" }).click()
      await page.keyboard.type("The 08:15 crossing is booked.")
      await esc()
      ensure(await question.isVisible(), "a message with text closed without asking")
      ensure(await keep.evaluate((el) => el === document.activeElement), "focus is not on Keep editing")
      const box = await question.boundingBox()
      if (app.phone) ensure(Math.round(box.width) === app.viewport.width && Math.round(box.y + box.height) === app.viewport.height, "on a phone the question is not a sheet at the foot")
      else ensure(Math.round(box.width) === 480, `the question is ${Math.round(box.width)} wide, not 480`)
      // Esc in the question keeps editing: it answers the question and leaves the message alone.
      await esc()
      ensure(!(await question.count()) && (await message.isVisible()), "Esc in the question did not keep the message")
      // The close button asks too (Cancel on a desktop does the same).
      await press(app, message.getByRole("button", { name: app.phone ? "Close" : "Cancel", exact: true }))
      ensure(await question.isVisible(), "closing a message with text by its button did not ask")
      // DISCARD closes it.
      await press(app, discard)
      ensure(!(await message.count()) && !(await question.count()), "Discard did not close the message")
      // A message reopened by Undo send holds its recipient and subject, so it asks as well.
      await send(app, "Saturday ferry")
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.press("Control+KeyZ")
      await app.settle()
      const subject = message.getByRole("textbox", { name: "Subject" })
      ensure((await subject.inputValue()) === "Saturday ferry", "Undo did not reopen the message")
      await subject.focus()
      await esc()
      ensure(await question.isVisible(), "a message reopened by Undo closed without asking")
      // KEEP EDITING keeps it, as it was.
      await press(app, keep)
      ensure((await message.isVisible()) && (await subject.inputValue()) === "Saturday ferry", "Keep editing did not keep the message")
      await message.getByRole("textbox", { name: "Message" }).click()
      await page.keyboard.type("The 08:15 crossing is booked. Shall we meet at the pier at 7:45?")
      // The picture: the question over the message.
      await esc()
      ensure(await keep.evaluate((el) => el === document.activeElement), "focus is not on Keep editing the second time")
    },
  },
  {
    // The form layer at its compose size (ADR-0087; brief 3.2): a dialog of 720 with the subject as its
    // title; the whole screen on a phone, with Send as the top row's float button.
    name: "form-layer-compose",
    sizes: ["desktop", "phone", "medium"],
    sean: { kind: "undrawn", area: "shell", screen: "form-layer-compose" },
    run: async (app) => {
      const { page } = app
      const message = page.getByRole("dialog", { name: "New message" })
      const write = async (form) => {
        await form.getByRole("combobox", { name: "To" }).pressSequentially("Marcus")
        await press(app, form.getByRole("option", { name: /Marcus Lee/ }))
        await form.getByRole("textbox", { name: "Subject" }).fill("Saturday ferry")
        await form.getByRole("textbox", { name: "Message" }).click()
        await page.keyboard.type("The 08:15 crossing is booked. Shall we meet at the pier at 7:45?")
      }
      // Ctrl+Enter from the message's own text sends it.
      await formLayer(app, { open: compose, write, primary: "Send", width: 720 })
      // Sent: take it back, so the picture is the form as it was written.
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.press("Control+KeyZ")
      await app.settle()
      ensure((await message.getByRole("textbox", { name: "Subject" }).inputValue()) === "Saturday ferry", "Ctrl+Enter did not send the message, or Undo did not bring it back")
      if (!app.phone) ensure(/Saturday ferry/.test(await message.locator('[data-slot="dialog-title"]').innerText()), "the header does not show the subject as typed")
      // Send later is still there: beside Send on a desktop, in the tools on a phone.
      ensure(await message.getByRole("button", { name: "Send later", exact: true }).isVisible(), "Send later is not reachable from the form")
    },
  },
  {
    // A split in the form layer; editing one adds DELETE at the start of the footer.
    name: "form-layer-split",
    sizes: ["desktop", "phone", "medium"],
    run: async (app) => {
      const { page } = app
      const show = page.getByRole("group", { name: "Show" })
      const open = async () => {
        await press(app, show.getByRole("button", { name: "New split" }))
        return page.getByRole("dialog", { name: "New split" })
      }
      const write = async (form) => {
        await form.getByRole("textbox", { name: "Name" }).fill("Bills")
        await form.getByRole("textbox", { name: "Subject contains" }).fill("invoice")
      }
      await formLayer(app, { open, write, primary: "Add split" })
      await toastGone(app)
      ensure(await show.getByRole("button", { name: "Bills" }).isVisible(), "Ctrl+Enter did not add the split")
      await press(app, show.getByRole("button", { name: "Edit split" }))
      ensure(await page.getByRole("dialog", { name: "Edit split" }).getByRole("button", { name: "Delete split", exact: true }).isVisible(), "an edited split has no Delete")
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
      await lane(app, "Screener")
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
  {
    // Mobile / 05: Mail's folders and accounts (ADR-0084). A sheet from the page head on a phone, a
    // popover at medium width, the sidebar's groups on a desktop. The rows are the core's lanes.
    name: "mail-folders-sheet",
    sizes: ["phone", "desktop", "medium"],
    sean: { kind: "drawn", area: "mail", screen: "folders-sheet" },
    run: async (app) => {
      const { page } = app
      const rows = page.getByRole("list", { name: "Inbox" }).getByRole("button")
      const everyone = await rows.count()
      // The Account radio group filters the list, and picking closes the layer.
      await press(app, (await groups(app)).getByRole("radio", { name: "Work", exact: true }))
      ensure(!(await switcherLayer(page).count()), "picking an account left the layer open")
      const work = await rows.count()
      ensure(work > 0 && work < everyone, `the Work account shows ${work} of ${everyone} conversations: it did not filter the list`)
      ensure(/Inbox\s*\/\/\s*Work/i.test(await page.locator('[data-slot="page-head-overline"]:visible').first().innerText()), "the page head does not name the account")
      // A place is a history entry: another folder, then Back, is the Inbox again, still on Work.
      await lane(app, "Starred")
      ensure((await headTitle(page)) === "Starred", "Starred did not open from the folders")
      ensure(!(await switcherLayer(page).count()), "picking a folder left the layer open")
      await goBack(app)
      ensure((await headTitle(page)) === "Today", "Back from Starred did not return to the Inbox")
      ensure((await rows.count()) === work, "Back from Starred lost the account")
      await goBack(app)
      ensure((await rows.count()) === everyone, "Back from the Work account did not return to all accounts")
      if (await switcher(page).count()) {
        // A pushed screen: Back returns to the list, in the same place.
        await conversation(app, /Token audit/)
        ensure(await page.getByRole("button", { name: "Back", exact: true }).first().isVisible(), "the conversation is not a pushed screen")
        await goBack(app)
        ensure(await page.getByRole("list", { name: "Inbox" }).isVisible(), "Back from a conversation did not return to the list")
        ensure((await headTitle(page)) === "Today", "Back from a conversation changed the place")
      }
      if (app.size === "phone") {
        // Scrolled, the small title the head collapses to is the same button (cross-app decisions §7).
        const list = page.getByRole("region", { name: "Mail", exact: true })
        await list.evaluate((el) => el.scrollTo(0, 400))
        await app.settle()
        const small = page.locator('button[data-slot="app-frame-top-row-title"]')
        ensure((await small.getAttribute("aria-label")) === "Inbox, All accounts. Change folder or account.", `the small title is not the switcher: ${await small.getAttribute("aria-label")}`)
        await press(app, small)
        ensure(await switcherLayer(page).isVisible(), "the small title did not open the folders")
        await leaveLayer(app)
        await list.evaluate((el) => el.scrollTo(0, 0))
        await app.settle()
        // A sideways swipe on the head steps the account; its keys are the arrows while the head has focus.
        await switcher(page).first().focus()
        await page.keyboard.press("ArrowRight")
        await app.settle()
        ensure(/Inbox\s*\/\/\s*Personal/i.test(await page.locator('[data-slot="page-head-overline"]:visible').first().innerText()), "stepping the account from the head did not go from All to the first account")
        await page.keyboard.press("ArrowLeft")
        await app.settle()
        ensure(/Inbox\s*\/\/\s*All accounts/i.test(await page.locator('[data-slot="page-head-overline"]:visible').first().innerText()), "stepping back did not return to all accounts")
        await page.evaluate(() => document.activeElement?.blur())
      }
      await groups(app)
    },
    assert: async (app) => {
      const { page } = app
      const list = await groups(app)
      ensure((await oneCurrent(list, "Mail's folders")) === "Inbox", "the Inbox is not the current place")
      for (const gone of ["Drafts", "Sent", "Spam"]) ensure(!(await list.getByRole("button", { name: gone, exact: true }).count()), `${gone} is listed, and the core has no such folder`)
      for (const row of ["Unread", "Starred", "Snoozed", "Waiting", "Scheduled", "Archive", "Team", "Add an account…"]) ensure(await list.getByRole("button", { name: row, exact: true }).count(), `${row} is not in Mail's folders`)
      const accounts = list.getByRole("radiogroup", { name: /Account/ })
      ensure((await accounts.getByRole("radio").count()) === 3, "the Account group is not All and the two accounts")
      ensure(await accounts.getByRole("radio", { name: "All", exact: true }).isChecked(), "All is not the checked account")
      ensure(!(await list.locator('[role="radio"][aria-current]').count()), "an account says it is the current place: it is a filter")
      if (await switcherLayer(page).count()) {
        ensure(/Mail\s*\/\/\s*All accounts/i.test(await list.innerText()), "the layer's overline does not name the section and the account")
        ensure(/Change folder or account\.$/.test(await switcher(page).first().getAttribute("aria-label")), "the page head button does not say what it changes")
      } else ensure(!(await switcher(page).count()), "the page head is a switcher although the sidebar lists the folders")
    },
  },
]
