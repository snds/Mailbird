import { ThemeProvider } from "next-themes"
import { useState } from "react"
import { toast } from "sonner"

import { AppShell } from "@/app/shell"
import { VERTICALS, type VerticalId } from "@/app/verticals"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CalendarView } from "@/features/calendar"
import { ContactsView } from "@/features/contacts"
import { MailView } from "@/features/mail"
import { NotesView } from "@/features/notes"

const VIEWS: Record<VerticalId, () => React.JSX.Element> = {
  mail: MailView,
  calendar: CalendarView,
  contacts: ContactsView,
  notes: NotesView,
}

export default function App() {
  const [active, setActive] = useState<VerticalId>("mail")
  const View = VIEWS[active]

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <AppShell
          active={active}
          onNavigate={setActive}
          onCreate={() => toast(`${VERTICALS.find((v) => v.id === active)!.create.label} — coming soon`)}
        >
          {/* key resets each vertical's selection when switching apps */}
          <View key={active} />
        </AppShell>
        <Toaster position="top-center" />
      </TooltipProvider>
    </ThemeProvider>
  )
}
