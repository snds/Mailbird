import { toast } from "sonner"

import { Switch } from "@unicron/ui"
import { useMenuBarPrefs, usePimAction } from "@/core/queries"
import type { MenuBarPrefs } from "@/core/types"

/** The menu-bar mini calendar's two switches (ADR-0054). Desktop only. */
export function MenuBarSettingsSection() {
  const { data: prefs } = useMenuBarPrefs()
  const set = usePimAction((c, p: MenuBarPrefs) => c.setMenuBarPrefs(p))
  if (!prefs) return null
  const change = (p: MenuBarPrefs, said: string) => set.mutate(p, { onSuccess: () => toast.success(said, { duration: 2000 }) })
  return (
    <section className="flex flex-col gap-3" aria-label="Menu bar">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id="menu-bar-heading" className="text-sm font-medium">
            Calendar in the menu bar
          </h3>
          <p className="text-xs text-muted-foreground">
            A small calendar under an icon in the menu bar, or the tray on Windows and Linux: what's next, the month, and quick add. While it's on, closing the window keeps Mailbird running there.
          </p>
        </div>
        <Switch
          checked={prefs.enabled}
          aria-labelledby="menu-bar-heading"
          disabled={set.isPending}
          onCheckedChange={(on) => change({ ...prefs, enabled: on }, on ? "The calendar is in the menu bar" : "The calendar left the menu bar")}
        />
      </div>
      {prefs.enabled && (
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 id="menu-bar-next-heading" className="text-sm font-medium">
              Show the next event's name
            </h3>
            <p className="text-xs text-muted-foreground">Beside the icon, like “Design review in 25 min”. Off: just the icon. Windows has no room for it, so it's in the icon's tooltip there.</p>
          </div>
          <Switch
            checked={prefs.showNext}
            aria-labelledby="menu-bar-next-heading"
            disabled={set.isPending}
            onCheckedChange={(on) => change({ ...prefs, showNext: on }, on ? "The menu bar shows what's next" : "The menu bar shows just the icon")}
          />
        </div>
      )}
    </section>
  )
}
