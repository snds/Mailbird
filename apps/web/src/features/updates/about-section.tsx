import { useState } from "react"
import { toast } from "sonner"

import { Button, Icon, Switch } from "@unicron/ui"

import { withUpdates } from "./update-client"
import { canCheck, channelName, updateLine } from "./update-model"
import { useUpdates } from "./use-updates"

/**
 * Settings → About (ADR-0076): the version and channel, "Check for updates"
 * (a check now, and the download if there is one), one status line,
 * "Restart to update" once an update is ready, "Reload app" otherwise, and
 * the switch for the automatic check. Desktop only.
 */
export function AboutSection() {
  const status = useUpdates()
  const [error, setError] = useState<string | null>(null)
  if (!status) return null

  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(String(e)))
  }
  const busy = status.state === "checking" || status.state === "downloading"

  return (
    <section className="flex flex-col gap-3" aria-label="Updates">
      <p className="text-sm">
        Vale {status.version} · {channelName(status)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canCheck(status)} onClick={() => run(withUpdates((c) => c.check()))}>
          <Icon name={busy ? "progress_activity" : "refresh"} data-icon="inline-start" />
          Check for updates
        </Button>
        {status.state === "ready" ? (
          <Button size="sm" onClick={() => run(withUpdates((c) => c.restart()))}>
            <Icon name="restart_alt" data-icon="inline-start" />
            Restart to update
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => run(withUpdates((c) => c.reload()))}>
            <Icon name="replay" data-icon="inline-start" />
            Reload app
          </Button>
        )}
        {status.state === "available" && status.link && (
          <Button size="sm" variant="outline" onClick={() => run(withUpdates((c) => c.openPage()))}>
            <Icon name="open_in_new" data-icon="inline-start" />
            Get it from GitHub
          </Button>
        )}
      </div>
      <p role="status" className={status.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {updateLine(status)}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status.enabled && (
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 id="update-auto-heading" className="text-sm font-medium">
              Check for updates automatically
            </h3>
            <p className="text-xs text-muted-foreground">When Vale opens and every six hours. A newer build downloads quietly and installs when you restart or quit.</p>
          </div>
          <Switch
            checked={status.auto_check}
            aria-labelledby="update-auto-heading"
            onCheckedChange={(on) =>
              withUpdates((c) => c.setAuto(on)).then(
                () => toast.success(on ? "Vale checks for updates on its own" : "Vale checks only when you ask", { duration: 2000 }),
                (e) => setError(String(e)),
              )
            }
          />
        </div>
      )}
    </section>
  )
}
