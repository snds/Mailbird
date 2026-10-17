import { QueryClientProvider } from "@tanstack/react-query"
import { useEffect } from "react"
import { ThemeProvider } from "next-themes"

import { AppShell } from "@/app/shell"
import { useUi } from "@/app/ui-store"
import { type VerticalId } from "@/app/verticals"
import { Toaster, TooltipProvider } from "@unicron/ui"
import { type AppJump, getCoreClient, isMember } from "@/core/client"
import { queryClient, useCoreEvents } from "@/core/queries"
import { APP_JUMP_KEY } from "@/lib/app-jump"
import { AccountsDialog } from "@/features/accounts"
import { CommandPalette } from "@/features/command-palette"
import { WritingDialog } from "@/features/writing-settings"
import { AdvancedMailDialog } from "@/features/advanced-mail"
import { AiSettingsDialog } from "@/features/ai-settings"
import { GatewayGate } from "@/features/gateway-sign-in"
import { BookingPage, ManageBookingPage } from "@/features/booking/page"
import { CalendarView } from "@/features/calendar"
import { ContactsView } from "@/features/contacts"
import { EventEditor } from "@/features/calendar/event-editor"
import { MiniCalendar } from "@/features/calendar/mini-calendar"
import { ReminderWatcher } from "@/features/calendar/reminder-watcher"
import { ContactEditor } from "@/features/contacts/contact-editor"
import { GrammarDialog } from "@/features/grammar"
import { QuickNote } from "@/features/notes/quick-note"
import { SplitEditor } from "@/features/mail/splits"
import { MailView } from "@/features/mail"
import { Composer, OutboxWatcher } from "@/features/mail/composer"
import { NotesView } from "@/features/notes"
import { ImageTextRunner } from "@/features/notes/image-text-runner"
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
  const setAccountsOpen = useUi((s) => s.setAccountsOpen)
  useCoreEvents()
  useAppJumps()
  const View = VIEWS[active]

  return (
    <>
      <AppShell
        active={active}
        onNavigate={setActive}
        onSettings={() => setAccountsOpen(true)}
        onCreate={() => {
          if (active === "mail") openComposer()
          else if (active === "calendar") openEventEditor()
          else if (active === "contacts") openContactEditor()
          else newNote()
        }}
      >
        {/* key resets each vertical's selection when switching apps */}
        <View key={active} />
      </AppShell>
      <Composer />
      <EventEditor />
      <ContactEditor />
      <SplitEditor />
      <GrammarDialog />
      <QuickNote />
      <AccountsDialog />
      <WritingDialog />
      <AdvancedMailDialog />
      <AiSettingsDialog />
      <CommandPalette
        onCreate={{
          mail: () => (setActive("mail"), openComposer()),
          calendar: () => (setActive("calendar"), openEventEditor()),
          contacts: () => (setActive("contacts"), openContactEditor()),
          notes: () => (setActive("notes"), newNote()),
        }}
      />
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
          {bookingToken ? (
            <div className="min-h-dvh bg-background">
              {bookingCode ? <ManageBookingPage token={bookingToken} code={bookingCode} /> : <BookingPage token={bookingToken} />}
            </div>
          ) : (
            <GatewayGate>{mini ? <MiniCalendar /> : <Root />}</GatewayGate>
          )}
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
