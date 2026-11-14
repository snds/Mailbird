import { Banner, Button, useAppFrame } from "@unicron/ui"
import { DEMO_APP } from "@/core/client"

/** Clears what the demo saved in this window, then starts it again on fresh sample data. */
async function resetDemo() {
  try {
    localStorage.clear()
    sessionStorage.clear()
    for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name)
  } catch {
    // Storage can be blocked; the reload still starts the demo over.
  }
  location.reload()
}

/**
 * On every screen of the demo app, pushed ones too (brief X10): what this is,
 * and a way back to a clean start. It cannot be dismissed. The shell places
 * it above the status line on a desktop (`in="frame"`); on a phone each
 * column holds it under the top row, where it stays as the page scrolls
 * (`in="column"`). Draws nothing outside the demo build.
 */
export function DemoBar({ in: place }: { in: "frame" | "column" }) {
  const frame = useAppFrame()
  if (!DEMO_APP || frame.phone !== (place === "column")) return null
  const banner = (
    <Banner
      tone="info"
      size="compact"
      data-role="demo-bar"
      body="You’re exploring the demo. Nothing here is real."
      action={
        <Button variant="secondary" size="sm" onClick={() => void resetDemo()}>
          Reset the demo
        </Button>
      }
    />
  )
  if (place === "frame") return <div className="pt-4">{banner}</div>
  // Under the floating top row, over the content that scrolls beneath it.
  return <div className="sticky top-0 z-10 bg-surface-ground px-4 pb-2">{banner}</div>
}
