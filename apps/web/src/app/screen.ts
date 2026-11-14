import { type ReactNode, useEffect, useMemo, useRef } from "react"
import { create } from "zustand"

/**
 * What the open screen tells the shell around it (ADR-0083). A view sets
 * these with the hooks below; the sidebar, the status line and the phone's
 * rows read them. Each is cleared when the view that set it goes away.
 */
interface ScreenState {
  /** The place inside the section: the breadcrumb's last part, and the phone's small title once the page has scrolled. */
  place: string | null
  /** The screen's own fact, at the end of the status line ("Synced // 09:16"). */
  fact: string | null
  /** The phone's place strip, shown in the bottom row once the page has scrolled and nothing is live. */
  strip: { meta: string; title: string } | null
  /** Fetch again: pull to refresh, a second tap on the active tab, the section's breadcrumb. */
  refresh: (() => unknown) | null
  /** Back to the section's first screen, at the top. */
  root: (() => void) | null
  /** What a pushed phone screen puts in its top bar and its bottom row. Each lane fills it for its own details. */
  pushed: PushedChrome | null
}

export interface PushedChrome {
  /** Up to two icon actions and More, as float buttons (size l), at the end of the top bar. */
  actions?: ReactNode
  /** The detail bottom row: up to two neutral float buttons, what fills the middle (a reply field), one primary. */
  start?: ReactNode
  fill?: ReactNode
  end?: ReactNode
}

export const useScreen = create<ScreenState>(() => ({ place: null, fact: null, strip: null, refresh: null, root: null, pushed: null }))

/** Sets one field while the caller is mounted, and clears it afterwards unless another view has set it since. */
function useField<K extends keyof ScreenState>(key: K, value: ScreenState[K]) {
  useEffect(() => {
    useScreen.setState({ [key]: value } as Pick<ScreenState, K>)
    return () => useScreen.setState((s) => (s[key] === value ? ({ [key]: null } as unknown as Pick<ScreenState, K>) : s))
  }, [key, value])
}

/** The place this view shows, as the breadcrumb and the phone's small title name it ("Inbox"). */
export const useScreenPlace = (place: string | null) => useField("place", place)

/** The screen's own fact for the status line, in sentence case; the line sets the capitals. Null shows none. */
export const useScreenFact = (fact: string | null) => useField("fact", fact)

/** The phone's place strip (States / 02): where you are over the newest item's name. Shown only when both are given. */
export function usePlaceStrip(meta: string | null, title: string | null) {
  const strip = useMemo(() => (meta && title ? { meta, title } : null), [meta, title])
  useField("strip", strip)
}

/** A function the shell calls with the latest closure, registered once. */
function useHandler<K extends "refresh" | "root">(key: K, fn: (() => unknown) | null | undefined) {
  const latest = useRef(fn)
  useEffect(() => {
    latest.current = fn
  })
  const has = !!fn
  useEffect(() => {
    if (!has) return
    const call = () => latest.current?.()
    useScreen.setState({ [key]: call } as Pick<ScreenState, K>)
    return () => useScreen.setState((s) => (s[key] === call ? ({ [key]: null } as unknown as Pick<ScreenState, K>) : s))
  }, [key, has])
}

/** How this view fetches again. Mail passes its sync; the others read their lists again. */
export const useRefresh = (fn: (() => unknown) | null | undefined) => useHandler("refresh", fn)

/** How this view returns to its first screen: closes what is open and scrolls its list to the top. */
export const useScreenRoot = (fn: (() => void) | null | undefined) => useHandler("root", fn)

/** A pushed phone screen's own controls. Pass a stable object (useMemo), or null. */
export const usePushedChrome = (pushed: PushedChrome | null) => useField("pushed", pushed)

/** Back to the open section's first screen, and fetch again: a second tap on its tab, or its breadcrumb. */
export function returnToRoot() {
  const { root, refresh } = useScreen.getState()
  root?.()
  void refresh?.()
}

/** A time for a status-line fact, by the clock as the frames write one (`09:16`); a day's name or a date once it is not today. */
export function factTime(secs: number, now = new Date()) {
  const at = new Date(secs * 1000)
  if (at.toDateString() !== now.toDateString()) return at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
}
