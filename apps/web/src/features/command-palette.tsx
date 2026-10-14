import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

import { useUi } from "@/app/ui-store"
import { VERTICALS } from "@/app/verticals"
import { Icon, type IconName } from "@/components/icon"
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command"
import { useScreener } from "@/core/queries"
import { LANES } from "@/features/mail/lanes"

const LANE_ICONS: Record<string, IconName> = {
  inbox: "inbox",
  screener: "how_to_reg",
  unread: "mark_email_unread",
  starred: "star",
  snoozed: "snooze",
  waiting: "notifications",
  scheduled: "schedule_send",
  archive: "archive",
}

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

/**
 * ⌘K / Ctrl+K: every create action, place, and setting by name, so the app
 * is learnable by typing (Superhuman, Linear). Mounted once at the root.
 */
export function CommandPalette({ onCreate }: { onCreate: Record<"mail" | "calendar" | "contacts" | "notes", () => void> }) {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  const [query, setQuery] = useState("")
  const { resolvedTheme, setTheme } = useTheme()
  const { data: screener } = useScreener()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      // The composer keeps the keyboard while you write.
      if (useUi.getState().composer) return
      e.preventDefault()
      useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const run = (fn: () => void) => () => {
    setOpen(false)
    setQuery("")
    fn()
  }
  const ui = useUi.getState
  const q = query.trim()

  return (
    <CommandDialog open={open} onOpenChange={(o) => (setOpen(o), !o && setQuery(""))} title="Command menu" description="Type to find an action, a place, or a setting">
      <Command>
        <CommandInput autoFocus placeholder="Type a command or search…" value={query} onValueChange={setQuery} />
        <CommandList>
          {/* No empty state: while you type, "Search mail" is always there. */}
          <CommandGroup heading="Create">
            <CommandItem onSelect={run(onCreate.mail)} keywords={["compose", "write", "email", "message"]}>
              <Icon name="edit_square" />
              New message
              <CommandShortcut>C</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(onCreate.calendar)} keywords={["meeting", "appointment"]}>
              <Icon name="event" />
              New event
            </CommandItem>
            <CommandItem onSelect={run(onCreate.contacts)} keywords={["person", "people"]}>
              <Icon name="person_add" />
              New contact
            </CommandItem>
            <CommandItem onSelect={run(onCreate.notes)}>
              <Icon name="note_add" />
              New note
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Mail">
            {LANES.filter((l) => l.id !== "screener" || screener?.enabled).map((l) => (
              <CommandItem key={l.id} value={`mail ${l.label}`} onSelect={run(() => ui().showMailTab(l.id))}>
                <Icon name={LANE_ICONS[l.id] ?? "inbox"} />
                {l.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Go to">
            {VERTICALS.filter((v) => v.id !== "mail").map((v) => (
              <CommandItem key={v.id} value={`go to ${v.label}`} onSelect={run(() => ui().setVertical(v.id))}>
                <Icon name={v.icon} />
                {v.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem onSelect={run(() => ui().setAccountsOpen(true))} keywords={["settings", "add account", "sign in"]}>
              <Icon name="manage_accounts" />
              Accounts
            </CommandItem>
            <CommandItem onSelect={run(() => ui().setWritingOpen(true))} keywords={["signature", "template", "snippet"]}>
              <Icon name="edit_note" />
              Signatures and templates
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))} keywords={["theme", "dark mode", "light mode", "appearance"]}>
              <Icon name={resolvedTheme === "dark" ? "light_mode" : "dark_mode"} />
              {resolvedTheme === "dark" ? "Use light mode" : "Use dark mode"}
            </CommandItem>
          </CommandGroup>
          {q && (
            <CommandGroup heading="Search" forceMount>
              {/* Always offered while typing. Its value never matches, so a command that does ranks above it. */}
              <CommandItem value="search-mail" forceMount onSelect={run(() => ui().showMailTab("inbox", q))}>
                <Icon name="search" />
                Search mail for “{q}”
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        <kbd className="font-mono">{mod}K</kbd> opens this menu anywhere.
      </p>
    </CommandDialog>
  )
}
