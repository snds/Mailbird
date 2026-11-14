import { QueryClientProvider } from "@tanstack/react-query"
import { Activity, useEffect, useState } from "react"
import { ThemeProvider } from "next-themes"

import { AppShell } from "@/app/shell"
import { useUi } from "@/app/ui-store"
import { type VerticalId } from "@/app/verticals"
import { Toaster, TooltipProvider } from "@unicron/ui"
import { type AppJump, getCoreClient, isMember } from "@/core/client"
import { queryClient, useCoreEvents } from "@/core/queries"
import { APP_JUMP_KEY } from "@/lib/app-jump"
import { CommandPalette } from "@/features/command-palette"
import { KeyboardShortcuts } from "@/features/keyboard-shortcuts"
import { SearchView } from "@/features/search"
import { leaveSearch, openSearch } from "@/features/search/open"
import { useSearchKey } from "@/features/search/search-key"
import { SettingsView } from "@/features/settings"
import { GatewayGate } from "@/features/gateway-sign-in"
import { BookingPage, ManageBookingPage } from "@/features/booking/page"
import { CalendarView } from "@/features/calendar"
import { ContactsView } from "@/features/contacts"
import { EventEditor } from "@/features/calendar/event-editor"
import { MiniCalendar } from "@/features/calendar/mini-calendar"
import { ReminderWatcher } from "@/features/calendar/reminder-watcher"
import { ContactEditor } from "@/features/contacts/contact-editor"
import { FirstRunGate } from "@/features/onboarding/first-run-gate"
import { QuickNote } from "@/features/notes/quick-note"
import { SplitEditor } from "@/features/mail/splits"
import { MailView } from "@/features/mail"
import { ComposeMail, OutboxWatcher } from "@/features/mail/composer"
import { NotesView } from "@/features/notes"
import { ImageTextRunner } from "@/features/notes/image-text-runner"
import { ImageViewer } from "@/features/notes/image-viewer"
import { NotesSyncRunner } from "@/features/notes/sync-runner"
import { TeamSyncRunner } from "@/features/team/team-runner"
import { useNewNote } from "@/features/notes/use-new-note"

const VIEWS: Record<VerticalId, () => React.JSX.Element> = {
  mail: MailView,
  calendar: CalendarView,
  contacts: ContactsView,
  notes: NotesView,
}

function Root() {
  const active = useUi((s) => s.vertical)
  const setActive = useUi((s) => s.setVertical)
  const newNote = useNewNote()
  const openComposer = useUi((s) => s.openComposer)
  const openEventEditor = useUi((s) => s.openEventEditor)
  const openContactEditor = useUi((s) => s.openContactEditor)
  const settings = useUi((s) => s.settings)
  const openSettings = useUi((s) => s.openSettings)
  const closeSettings = useUi((s) => s.closeSettings)
  const search = useUi((s) => !!s.search)
  useCoreEvents()
  useAppJumps()
  useSearchKey()
  // A result opened from Search is a jump (ADR-0085). The section stood hidden behind Search and reads
  // a jump only as it mounts, so it starts afresh for one; left any other way, it comes back as it was.
  const [fresh, setFresh] = useState(0)
  const [searching, setSearching] = useState(search)
  if (searching !== search) {
    setSearching(search)
    if (!search && useUi.getState().jump) setFresh(fresh + 1)
  }
  const View = VIEWS[active]
  // Each kind's create flow from anywhere: the command menu's CREATE group and quick create run the same ones.
  const create = {
    mail: () => (setActive("mail"), openComposer()),
    calendar: () => (setActive("calendar"), openEventEditor()),
    contacts: () => (setActive("contacts"), openContactEditor()),
    notes: () => (setActive("notes"), newNote()),
  }

  return (
    <>
      <AppShell
        active={active}
        // The open area's own button, from settings, returns to it as it was.
        onNavigate={(id) => (settings && id === active ? closeSettings() : search && !settings && id === active ? leaveSearch() : setActive(id))}
        settingsOpen={!!settings}
        searchOpen={search && !settings}
        onSearch={() => openSearch()}
        onLeaveSearch={leaveSearch}
        onSettings={() => openSettings()}
        onCloseSettings={closeSettings}
        onCreate={() => {
          if (active === "mail") openComposer()
          else if (active === "calendar") openEventEditor()
          else if (active === "contacts") openContactEditor()
          else newNote()
        }}
        handlers={create}
      >
        {/* key resets each vertical's selection when switching apps. Settings
            hides the area instead of unmounting it, so coming back finds it as
            you left it (ADR-0075). Hidden, it also lets go of the frame: its
            columns, its page head and its way back are Settings' meanwhile
            (ADR-0083). Its own box keeps its columns from standing next to
            Settings' in the frame's eyes. Search stands in its place the
            same way (ADR-0085). */}
        <div className="contents">
          <Activity mode={settings || search ? "hidden" : "visible"}>
            <View key={`${active}/${fresh}`} />
          </Activity>
        </div>
        {settings ? <SettingsView /> : search && <SearchView />}
      </AppShell>
      <ComposeMail />
      <EventEditor />
      <ContactEditor />
      <SplitEditor />
      <KeyboardShortcuts />
      <QuickNote />
      <ImageViewer />
      <CommandPalette onCreate={create} />
      <OutboxWatcher />
      {/* Reminders, notes, and shared links are the owner's; a team member has mail (ADR-0063). */}
      {!isMember() && (
        <>
          <ReminderWatcher />
          <NotesSyncRunner />
          <TeamSyncRunner />
          <ImageTextRunner />
        </>
      )}
    </>
  )
}

/** What the menu-bar mini calendar asks this window to open (ADR-0054): an
 * `app:jump` event on the desktop, or a note the demo's mini page left. */
function useAppJumps() {
  useEffect(() => {
    const go = (j: AppJump) => {
      const ui = useUi.getState()
      if (j.kind === "newEvent") {
        ui.setVertical("calendar")
        ui.openEventEditor()
      } else ui.jumpTo({ kind: "event", id: j.id, start: j.start })
    }
    let saved: AppJump | null = null
    try {
      const v = sessionStorage.getItem(APP_JUMP_KEY)
      sessionStorage.removeItem(APP_JUMP_KEY)
      saved = v ? (JSON.parse(v) as AppJump) : null
    } catch {
      // No storage, or a bad entry: open as usual.
    }
    if (saved) go(saved)
    let off: (() => void) | null = null
    let gone = false
    void getCoreClient().then((c) => {
      if (!gone) off = c.on("app:jump", (p) => go(p as AppJump))
    })
    return () => {
      gone = true
      off?.()
    }
  }, [])
}

/** The menu-bar mini calendar's own window loads the app with `?mini`. */
const mini = new URLSearchParams(location.search).has("mini")

/** A scheduling link's public page: `/book/<token>`, no sign-in (ADR-0026),
 *  and a booking's own page, `/book/<token>/b/<code>` (ADR-0031). */
const bookingPath = /^\/book\/([A-Za-z0-9_-]{8,64})(?:\/b\/([A-Za-z0-9_-]{8,64}))?\/?$/.exec(location.pathname)
const bookingToken = bookingPath?.[1] ?? null
const bookingCode = bookingPath?.[2] ?? null

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          {/* The public booking pages, the gateway's door and the menu-bar window stand outside the shell,
              each with its own Toaster; inside the shell the frame holds it and places its toasts. */}
          {bookingToken ? (
            <>
              <div className="min-h-dvh bg-background">
                {bookingCode ? <ManageBookingPage token={bookingToken} code={bookingCode} /> : <BookingPage token={bookingToken} />}
              </div>
              <Toaster />
            </>
          ) : (
            <GatewayGate>
              {mini ? (
                <>
                  <MiniCalendar />
                  <Toaster />
                </>
              ) : (
                <FirstRunGate>
                  <Root />
                </FirstRunGate>
              )}
            </GatewayGate>
          )}
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
