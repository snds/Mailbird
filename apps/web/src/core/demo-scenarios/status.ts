import { useSyncStatus } from "@/features/notes/sync"
import { demoOffline } from "@/hooks/use-online"

import type { DueReminder, OutboxItem } from "../types"
import type { DemoScenarios } from "../demo-scenarios"

const HOUR = 3600
const nowSecs = () => Math.floor(Date.now() / 1000)
/** A read that never answers, so its screen keeps its skeleton. */
const never = <T,>() => new Promise<T>(() => {})

/**
 * Status (ADR-0081, ADR-0086): the sync, sending and connection states the
 * status strip, the status line, the section banners and the load states
 * show. Names and words are the demo's own.
 */
export const status: DemoScenarios = {
  /** The Work account stopped syncing forty minutes ago: its server refused the sign-in. */
  "sync-error": ({ state }) => {
    const work = state.accounts.find((a) => a.id === "work")
    if (work) Object.assign(work, { lastSync: nowSecs() - 40 * 60, lastError: "The mail server refused the sign-in. Check the app password for me@studio.example." })
  },
  /** The Work account was just added: it has no mail yet, and its first sync is running. */
  "first-sync": ({ state }) => {
    const work = state.accounts.find((a) => a.id === "work")
    if (work) Object.assign(work, { lastSync: null, davLastSync: null })
    for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i]!.accountId === "work") state.messages.splice(i, 1)
  },
  /** A check for new mail that never comes back, so "Checking" stays up once it is asked for. */
  syncing: ({ wrap }) => {
    wrap("syncNow", () => () => never<void>())
  },
  /** A message that could not be sent waits in the outbox, with the server's words. */
  "send-fails": ({ state }) => {
    const item: OutboxItem = {
      id: "outbox-failed-estimate",
      draft: {
        accountId: "work",
        to: [{ name: "Priya Raman", email: "priya@studio.example" }],
        cc: [],
        subject: "Estimate for the spring catalogue",
        body: "Priya, the estimate is attached. The print run is the open question; I priced both sizes.",
        bodyHtml: null,
        inReplyTo: null,
        references: [],
        attachments: [],
      },
      sendAt: nowSecs() - 5 * 60,
      state: "failed",
      error: "The server refused the message: the mailbox me@studio.example is over its sending limit for today.",
    }
    state.outbox.set(item.id, item)
  },
  /** Lists never answer, so every section shows its loading state. */
  slow: ({ wrap }) => {
    wrap("listMessages", () => () => never())
    wrap("listOccurrences", () => () => never())
    wrap("listContacts", () => () => never())
    wrap("listNotes", () => () => never())
  },
  /** The Work account's calendars and contacts did not sync. */
  "dav-error": ({ state }) => {
    const work = state.accounts.find((a) => a.id === "work")
    if (work) Object.assign(work, { davLastSync: nowSecs() - 2 * HOUR, davError: "The calendar server answered 401: the app password was not accepted." })
  },
  /** The notes relay refused this device. */
  "relay-error": () => {
    useSyncStatus.setState({ status: "error", error: "The relay refused the token" })
  },
  /** Two accounts and no mail at all. */
  "empty-inbox": ({ state }) => {
    state.messages.splice(0)
    state.followUps.clear()
  },
  /** A fresh start: no account yet. */
  "no-account": ({ state }) => {
    state.accounts.splice(0)
    state.messages.splice(0)
    state.followUps.clear()
  },
  /** The device has no network. Only this scenario makes the demo say so (brief X4). */
  offline: () => {
    demoOffline.on = true
  },
  /** Two reminders came due while Vale was closed, a few minutes ago: those of the two events nearest to now. Handed over once, as the core does. */
  missed: ({ client, wrap }) => {
    let taken = false
    wrap("takeMissedReminders", () => async () => {
      if (taken) return []
      taken = true
      const now = nowSecs()
      const near = (await client.listOccurrences(now - 24 * HOUR, now + 12 * HOUR)).filter((o) => !o.allDay).sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
      return near
        .slice(0, 2)
        .sort((a, b) => a.start - b.start)
        .map((o): DueReminder => ({ eventId: o.eventId, title: o.title, location: o.location, start: o.start, fireAt: Math.min(o.start, now) - 5 * 60 }))
    })
  },
}
