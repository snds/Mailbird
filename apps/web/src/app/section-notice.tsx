import { Banner, Button, useAppFrame } from "@unicron/ui"

import { useSectionBanners } from "./section-banner"
import { useUi } from "./ui-store"

/**
 * Where the open section's banner shows. From medium width up it stands
 * under the status line, across the content (Desktop / 05): `in="frame"`. On
 * a phone it stands under the page head, at the top of the list
 * (Mobile / 07): `in="column"`. Settings and Search show none: the banner
 * belongs to the section behind them.
 */
export function SectionNotice({ in: place }: { in: "frame" | "column" }) {
  const frame = useAppFrame()
  const section = useUi((s) => (s.settings || s.search ? null : s.vertical))
  const banner = useSectionBanners((s) => (section ? (s[section] ?? null) : null))
  if (!banner || frame.phone !== (place === "column")) return null
  return (
    <div data-role="section-banner" className={place === "frame" ? "pt-6" : "px-4 pb-4"}>
      <Banner
        tone="critical"
        title={banner.title}
        body={banner.body}
        action={
          banner.action && (
            <Button variant="secondary" size="sm" loading={banner.action.loading} onClick={banner.action.onClick}>
              {banner.action.label}
            </Button>
          )
        }
      />
    </div>
  )
}
