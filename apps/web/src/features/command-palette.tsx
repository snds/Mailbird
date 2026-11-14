import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

import { useUi } from "@/app/ui-store"
import { VERTICALS } from "@/app/verticals"
import { Icon, type IconName, Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut, toast } from "@unicron/ui"
import { isTauri } from "@/core/client"
import { useKeyBindings, useScreener } from "@/core/queries"
import { LANES } from "@/features/mail/lanes"
import { withUpdates } from "@/features/updates/update-client"
import { keyLabel } from "@/lib/keys"

const LANE_ICONS: Record<string, IconName> = {
  inbox: "email",
  screener: "user--admin",
  unread: "email--new",
  starred: "star",
  snoozed: "time",
  waiting: "notification",
  scheduled: "time",
  archive: "archive",
}

/** "Check for updates" from the menu: checks, and opens Settings → About, where the outcome shows. */
function checkForUpdates() {
  useUi.getState().openSettings("about")
  void withUpdates((c) => c.check()).catch((e) => toast.error("Couldn't check for updates", { description: String(e) }))
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
  const { setTheme } = useTheme()
  const { data: screener } = useScreener()
  const { data: keys } = useKeyBindings()
  const quickLabel = useUi((s) => s.quickContext?.label)

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
              <Icon name="edit" />
              New message
              {keys?.["mail.compose"] && <CommandShortcut>{keyLabel(keys["mail.compose"])}</CommandShortcut>}
            </CommandItem>
            <CommandItem onSelect={run(onCreate.calendar)} keywords={["meeting", "appointment"]}>
              <Icon name="calendar" />
              New event
            </CommandItem>
            <CommandItem onSelect={run(onCreate.contacts)} keywords={["person", "people"]}>
              <Icon name="user--multiple" />
              New contact
            </CommandItem>
            <CommandItem onSelect={run(() => ui().openQuickNote())} keywords={["jot", "scratch", "quick", "note"]}>
              <Icon name="edit" />
              Quick note{quickLabel ? ` about ${quickLabel}` : ""}
              <CommandShortcut>⌥N</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(onCreate.notes)}>
              <Icon name="notebook" />
              New note
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Mail">
            {LANES.filter((l) => l.id !== "screener" || screener?.enabled).map((l) => (
              <CommandItem key={l.id} value={`mail ${l.label}`} onSelect={run(() => ui().showMailTab(l.id))}>
                <Icon name={LANE_ICONS[l.id] ?? "email"} />
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
            <CommandItem onSelect={run(() => ui().openSettings())} keywords={["preferences", "options"]}>
              <Icon name="settings" />
              Settings
            </CommandItem>
            <CommandItem onSelect={run(() => ui().openSettings("accounts"))} keywords={["settings", "add account", "sign in"]}>
              <Icon name="user--settings" />
              Accounts
            </CommandItem>
            <CommandItem onSelect={run(() => ui().openSettings("writing"))} keywords={["signature", "template", "snippet"]}>
              <Icon name="edit" />
              Signatures and templates
            </CommandItem>
            <CommandItem onSelect={run(() => ui().setShortcutsOpen(true))} keywords={["keyboard", "shortcuts", "keys", "hotkeys"]}>
              <Icon name="keyboard" />
              Keyboard shortcuts
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => ui().openSettings("shortcuts"))} keywords={["keyboard", "swipe", "gestures", "change keys"]}>
              <Icon name="touch--interaction" />
              Change keys and swipes
            </CommandItem>
            {/* The desktop's updater (ADR-0076); its outcome shows in Settings → About. */}
            {isTauri() && (
              <>
                <CommandItem onSelect={run(() => checkForUpdates())} keywords={["update", "upgrade", "new version", "about"]}>
                  <Icon name="renew" />
                  Check for updates
                </CommandItem>
                <CommandItem onSelect={run(() => void withUpdates((c) => c.reload()).catch((e) => toast.error("Couldn't reload Vale", { description: String(e) })))} keywords={["restart", "relaunch", "reopen"]}>
                  <Icon name="restart" />
                  Reload app
                </CommandItem>
              </>
            )}
            {/* The same three choices as Settings → Appearance, saved in the same place (ADR-0082). */}
            <CommandItem onSelect={run(() => setTheme("system"))} keywords={["appearance", "device", "automatic", "auto", "dark mode", "light mode"]}>
              <Icon name="devices" />
              Theme: System
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("light"))} keywords={["appearance", "light mode", "light", "day"]}>
              <Icon name="sun" />
              Theme: Stone
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("dark"))} keywords={["appearance", "dark mode", "dark", "night"]}>
              <Icon name="moon" />
              Theme: Graphite
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
        <kbd className="font-mono">{mod}K</kbd> opens this menu anywhere. <kbd className="font-mono">?</kbd> lists every key.
      </p>
    </CommandDialog>
  )
}
