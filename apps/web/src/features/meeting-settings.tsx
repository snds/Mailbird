import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { useMeetingPrefs, usePimAction } from "@/core/queries"

/** How Join opens calls (ADR-0030). Lives in Accounts and settings. */
export function MeetingSettingsSection() {
  const { data: prefs } = useMeetingPrefs()
  const set = usePimAction((c, openInApps: boolean) => c.setMeetingPrefs({ openInApps }))
  if (!prefs) return null
  return (
    <section className="flex items-start gap-3" aria-labelledby="meetings-heading">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 id="meetings-heading" className="text-sm font-medium">
          Open video calls in their apps
        </h3>
        <p className="text-xs text-muted-foreground">Join opens Zoom and Teams calls in their apps, if you have them. Off: every call opens in your browser. Google Meet, Jitsi, and the rest always do.</p>
      </div>
      <Switch
        checked={prefs.openInApps}
        aria-labelledby="meetings-heading"
        disabled={set.isPending}
        onCheckedChange={(on) => set.mutate(on, { onSuccess: () => toast.success(on ? "Calls open in their apps" : "Calls open in your browser", { duration: 2000 }) })}
      />
    </section>
  )
}
