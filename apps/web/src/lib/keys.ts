/**
 * Single-key commands (ADR-0032). One table: the handlers, the list in
 * Shortcuts and gestures, and the hints in ⌘K all read it, so they can't
 * drift apart. Mirrors `KEY_COMMANDS` in the core, which keeps your keys.
 */
export type KeyArea = "mail" | "calendar"

export interface KeyCommand {
  id: string
  area: KeyArea
  does: string
  default: string
}

export const KEY_COMMANDS: KeyCommand[] = [
  { id: "mail.next", area: "mail", does: "Next conversation", default: "j" },
  { id: "mail.previous", area: "mail", does: "Previous conversation", default: "k" },
  { id: "mail.archive", area: "mail", does: "Archive, or back to the inbox", default: "e" },
  { id: "mail.star", area: "mail", does: "Star or unstar", default: "s" },
  { id: "mail.unread", area: "mail", does: "Mark unread", default: "u" },
  { id: "mail.snooze-tomorrow", area: "mail", does: "Snooze until tomorrow", default: "h" },
  { id: "mail.snooze-next-week", area: "mail", does: "Snooze until next week", default: "" },
  { id: "mail.remind", area: "mail", does: "Remind me in 3 days if nobody replies", default: "" },
  { id: "mail.newsletters", area: "mail", does: "Always in Newsletters", default: "" },
  { id: "mail.compose", area: "mail", does: "Write a message", default: "c" },
  { id: "mail.search", area: "mail", does: "Search mail", default: "/" },
  { id: "calendar.today", area: "calendar", does: "Go to today", default: "t" },
  { id: "calendar.day", area: "calendar", does: "Day view", default: "d" },
  { id: "calendar.week", area: "calendar", does: "Week view", default: "w" },
  { id: "calendar.month", area: "calendar", does: "Month view", default: "m" },
  { id: "calendar.agenda", area: "calendar", does: "Agenda", default: "a" },
  { id: "calendar.previous", area: "calendar", does: "Previous day, week, or month", default: "ArrowLeft" },
  { id: "calendar.next", area: "calendar", does: "Next day, week, or month", default: "ArrowRight" },
]

/** Command id → key, as `KeyboardEvent.key` names it ("" for none). */
export type KeyBindings = Record<string, string>

export const DEFAULT_KEYS: KeyBindings = Object.fromEntries(KEY_COMMANDS.map((c) => [c.id, c.default]))

const NAMED: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Delete: "Delete",
  Backspace: "⌫",
}

/** Keys that never change: Esc closes, ? lists the keys, and ⌘K. */
export const FIXED_KEYS: { area: KeyArea | "everywhere"; keys: string[]; does: string }[] = [
  { area: "mail", keys: ["Esc"], does: "Close the conversation" },
  { area: "everywhere", keys: ["⌘K"], does: "Commands and search" },
  { area: "everywhere", keys: ["?"], does: "This list" },
]

/** How a key is printed: "E", "⇧E" for Shift+E, "←". */
export function keyLabel(key: string): string {
  if (!key) return ""
  if (NAMED[key]) return NAMED[key]
  if (key.length === 1 && key !== key.toLowerCase()) return `⇧${key}`
  return key.toUpperCase()
}

/** The same key for `aria-keyshortcuts` ("Shift+E"), or undefined for none. */
export function ariaKey(key: string | undefined): string | undefined {
  if (!key) return undefined
  return key.length === 1 && key !== key.toLowerCase() ? `Shift+${key}` : key
}

/** Why `key` can't be bound, if it can't. Same rules as the core. */
export function keyProblem(key: string): string | null {
  if (key === "" || NAMED[key]) return null
  if (key === "?") return "? opens the list of keys, so it stays as it is"
  if ([...key].length === 1 && key.trim() !== "") return null
  return `“${key}” can't be a shortcut: use one key (Shift is fine)`
}

/** Which command `key` does in `area`, if any. */
export function commandFor(bindings: KeyBindings | undefined, area: KeyArea, key: string): string | undefined {
  const keys = bindings ?? DEFAULT_KEYS
  return KEY_COMMANDS.find((c) => c.area === area && keys[c.id] === key)?.id
}

/** Laid over the defaults, as the core does. */
export function mergedKeys(saved: KeyBindings): KeyBindings {
  const out: KeyBindings = {}
  for (const c of KEY_COMMANDS) {
    const clash = Object.entries(saved).some(([id, k]) => k === c.default && c.default !== "" && id.split(".")[0] === c.area && !(c.id in saved))
    out[c.id] = c.id in saved ? saved[c.id]! : clash ? "" : c.default
  }
  return out
}

/**
 * Sets `id` to `key`. If another command in the area has that key, it
 * takes `id`'s old one (a swap), so nothing is lost silently.
 */
export function rebind(bindings: KeyBindings, id: string, key: string): { next: KeyBindings; swapped?: KeyCommand } {
  const area = id.split(".")[0] as KeyArea
  const other = KEY_COMMANDS.find((c) => c.id !== id && c.area === area && key !== "" && bindings[c.id] === key)
  const next = { ...bindings, [id]: key }
  if (other) next[other.id] = bindings[id] ?? ""
  return { next, swapped: other }
}
