import { Button, Icon } from "@unicron/ui"

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

/** On every screen of the demo app: what this is, and a way back to a clean start. */
export function DemoBar() {
  return (
    <div role="status" data-role="demo-bar" className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 [&_svg]:size-4">
        <Icon name="information" />
        You’re exploring the demo. Nothing here is real.
      </span>
      <Button type="button" variant="link" size="inline" onClick={() => void resetDemo()}>
        Reset demo data
      </Button>
    </div>
  )
}
