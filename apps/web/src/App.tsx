import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"

import { AppShell } from "@/app/shell"
import { useUi } from "@/app/ui-store"
import { type VerticalId } from "@/app/verticals"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient, useCoreEvents } from "@/core/queries"
import { AccountsDialog } from "@/features/accounts"
import { CommandPalette } from "@/features/command-palette"
import { WritingDialog } from "@/features/writing-settings"
import { GatewayGate } from "@/features/gateway-sign-in"
import { BookingPage, ManageBookingPage } from "@/features/booking/page"
import { CalendarView } from "@/features/calendar"
import { ContactsView } from "@/features/contacts"
import { EventEditor } from "@/features/calendar/event-editor"
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
      <CommandPalette
        onCreate={{
          mail: () => (setActive("mail"), openComposer()),
          calendar: () => (setActive("calendar"), openEventEditor()),
          contacts: () => (setActive("contacts"), openContactEditor()),
          notes: () => (setActive("notes"), newNote()),
        }}
      />
      <OutboxWatcher />
      <ReminderWatcher />
      <NotesSyncRunner />
      <ImageTextRunner />
    </>
  )
}

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
            <GatewayGate>
              <Root />
            </GatewayGate>
          )}
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
