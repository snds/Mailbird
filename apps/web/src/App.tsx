import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { useState } from "react"
import { toast } from "sonner"

import { AppShell } from "@/app/shell"
import { useUi } from "@/app/ui-store"
import { VERTICALS, type VerticalId } from "@/app/verticals"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient, useCoreEvents } from "@/core/queries"
import { AccountsDialog } from "@/features/accounts"
import { CalendarView } from "@/features/calendar"
import { ContactsView } from "@/features/contacts"
import { MailView } from "@/features/mail"
import { Composer, OutboxWatcher } from "@/features/mail/composer"
import { NotesView } from "@/features/notes"

const VIEWS: Record<VerticalId, () => React.JSX.Element> = {
  mail: MailView,
  calendar: CalendarView,
  contacts: ContactsView,
  notes: NotesView,
}

function Root() {
  const [active, setActive] = useState<VerticalId>("mail")
  const openComposer = useUi((s) => s.openComposer)
  const setAccountsOpen = useUi((s) => s.setAccountsOpen)
  useCoreEvents()
  const View = VIEWS[active]

  return (
    <>
      <AppShell
        active={active}
        onNavigate={setActive}
        onSettings={() => setAccountsOpen(true)}
        onCreate={() =>
          active === "mail"
            ? openComposer()
            : toast(`${VERTICALS.find((v) => v.id === active)!.create.label} — coming soon`)
        }
      >
        {/* key resets each vertical's selection when switching apps */}
        <View key={active} />
      </AppShell>
      <Composer />
      <AccountsDialog />
      <OutboxWatcher />
    </>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          <Root />
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
