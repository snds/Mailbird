import { toast } from "@unicron/ui"
import { create } from "zustand"

import { getCoreClient } from "@/core/client"
import { queryClient, useAccounts } from "@/core/queries"
import type { Account } from "@/core/types"
import { undoSend, useSending } from "@/features/mail/sending"
import { useOnline } from "@/hooks/use-online"

import { factTime } from "./screen"

/**
 * Live status, built once (ADR-0086; brief X4, cross-app decisions §1): what
 * Vale is doing right now. One model, `useLiveStatus`, feeds the phone's
 * status strip and the desktop's status line (app/status.tsx), so the two always say the same
 * thing. Finished things are toasts; broken things the person can fix are a
 * section's banner (app/section-banner.tsx). Background checks are silent.
 */
interface StatusState {
  /** Checks for mail the person asked for that have not come back yet. */
  checking: number
  /** The gateway is taking a new image or restarting (Settings › About sets it while it waits). */
  serverUpdating: boolean
}

export const useStatus = create<StatusState>(() => ({ checking: 0, serverUpdating: false }))

/** Settings' server update says when it starts and ends waiting for the gateway. */
export const setServerUpdating = (serverUpdating: boolean) => useStatus.setState({ serverUpdating })

/**
 * Checks every account for new mail because the person asked: pull to
 * refresh, a second tap on Mail's tab, "Check again". The status says so
 * while it runs; it ends without a toast, and the lists read again.
 */
export async function checkMail() {
  useStatus.setState((s) => ({ checking: s.checking + 1 }))
  try {
    await (await getCoreClient()).syncNow()
  } catch (e) {
    toast.error("Couldn’t check for mail", { description: e instanceof Error ? e.message : String(e) })
  } finally {
    useStatus.setState((s) => ({ checking: s.checking - 1 }))
    void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    void queryClient.invalidateQueries({ queryKey: ["messages"] })
    void queryClient.invalidateQueries({ queryKey: ["thread"] })
  }
}

/** One live state, in the words each place uses. Capitals are the parts' own. */
export interface LiveStatus {
  kind: "sending" | "updating" | "offline" | "first-sync" | "checking" | "not-syncing"
  tone: "live" | "neutral" | "critical"
  /** The strip's overline and the line under it. */
  meta: string
  title: string
  /** The status line's words. */
  line: string
  /** Said once by a screen reader; never the ticks of a countdown. */
  announce: string
  /** Seconds left and the window's length (sending). */
  countdown?: number
  total?: number
  /** The one action: UNDO. */
  undo?: () => void
}

/** Accounts by name: "Personal + Work" for two, a count from three. */
const names = (accounts: Account[]) => (accounts.length <= 2 ? accounts.map((a) => a.displayName).join(" + ") : `${accounts.length} accounts`)
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** When every account last finished a sync: the oldest of them, so the line never claims more than is true. */
function lastSynced(accounts: Account[]) {
  const times = accounts.map((a) => a.lastSync).filter((t): t is number => t !== null)
  return times.length ? factTime(Math.min(...times)) : null
}

/**
 * The one live state to show, by what matters most to act on: a send that
 * can still be taken back; the server restarting; no network; an account
 * that stopped syncing; an account's first sync; a check the person asked for.
 */
export function useLiveStatus(): LiveStatus | null {
  const sending = useSending()
  const online = useOnline()
  const checking = useStatus((s) => s.checking > 0)
  const updating = useStatus((s) => s.serverUpdating)
  const { data: accounts = [] } = useAccounts()

  if (sending) {
    const several = sending.items.length > 1
    const subject = sending.newest.draft.subject.trim() || "(no subject)"
    const what = several ? `Sending // ${sending.items.length} messages` : "Sending"
    return {
      kind: "sending",
      tone: "live",
      meta: what,
      title: subject,
      line: what,
      announce: `Sending ${several ? `${sending.items.length} messages` : subject}. ${sending.total} seconds to undo.`,
      countdown: sending.secondsLeft,
      total: sending.total,
      undo: () => void undoSend(sending.newest.id),
    }
  }
  if (updating) return { kind: "updating", tone: "live", meta: "Updating server", title: "The gateway goes away for a moment", line: "Updating server", announce: "Updating the server. The gateway goes away for a moment." }
  if (!online) {
    const at = lastSynced(accounts)
    const since = at ? `Last synced ${at}` : "Not synced yet"
    return { kind: "offline", tone: "neutral", meta: "Offline", title: since, line: `Offline // ${since}`, announce: `Offline. ${since}.` }
  }
  const failing = accounts.filter((a) => a.lastError)
  if (failing.length) {
    const who = failing.length === 1 ? failing[0]!.displayName : count(failing.length, "account")
    const at = failing.length === 1 && failing[0]!.lastSync !== null ? factTime(failing[0]!.lastSync) : null
    const line = `${who} // Not syncing${at ? ` since ${at}` : ""}`
    return { kind: "not-syncing", tone: "critical", meta: who, title: `Not syncing${at ? ` since ${at}` : ""}`, line, announce: `${who} stopped syncing${at ? ` at ${at}` : ""}.` }
  }
  const first = accounts.filter((a) => a.lastSync === null)
  if (first.length) {
    const line = `First sync // ${names(first)}`
    return { kind: "first-sync", tone: "live", meta: line, title: "Fetching mail", line, announce: `First sync of ${names(first)}. Fetching mail.` }
  }
  if (checking && accounts.length) {
    const title = `Checking ${count(accounts.length, "account")}`
    return { kind: "checking", tone: "live", meta: `Syncing // ${names(accounts)}`, title, line: `Checking // ${count(accounts.length, "account")}`, announce: `${title} for new mail.` }
  }
  return null
}
