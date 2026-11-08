import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Button, Icon, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Switch } from "@unicron/ui"
import { type GatewayUpdates, checkGatewayUpdates, gatewayUpdates, setGatewayAutoCheck } from "@/core/client"

const KEY = ["gateway-updates"]

/**
 * Settings → Gateway updates (ADR-0077), for the gateway's owner: its
 * version and channel, one status line, Check for updates, and the switch
 * for the automatic check. When a newer image is out, the command that
 * takes it. The gateway can't restart itself, so there's no Update button
 * yet: one-click Update and Reload come with a helper on its host.
 */
export function GatewayUpdatesSection() {
  const qc = useQueryClient()
  const { data: status, error: loadError } = useQuery({ queryKey: KEY, queryFn: gatewayUpdates, staleTime: 60_000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError.message}
      </p>
    )
  }
  if (!status) return null

  const run = async (work: () => Promise<GatewayUpdates>) => {
    setError(null)
    setBusy(true)
    try {
      qc.setQueryData(KEY, await work())
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Gateway updates">
      <p className="text-sm">
        Vale gateway {status.version} · {status.channel === "main" ? "main channel (every merged change)" : "stable channel"}
      </p>
      {status.enabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy || status.state === "checking"} onClick={() => void run(checkGatewayUpdates)}>
            <Icon name={busy ? "progress_activity" : "refresh"} data-icon="inline-start" />
            Check for updates
          </Button>
        </div>
      )}
      <p role="status" className={status.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {status.line}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status.state === "available" && status.command && <UpdateCommand status={status} command={status.command} />}
      {status.checkedAt && <p className="text-xs text-muted-foreground">Last checked {new Date(status.checkedAt * 1000).toLocaleString()}.</p>}
      {status.enabled && (
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 id="gateway-update-auto-heading" className="text-sm font-medium">
              Check for updates automatically
            </h3>
            <p className="text-xs text-muted-foreground">When the gateway starts and every six hours. It only looks: nothing is downloaded or restarted.</p>
          </div>
          <Switch
            checked={status.autoCheck}
            aria-labelledby="gateway-update-auto-heading"
            onCheckedChange={(on) =>
              void run(() => setGatewayAutoCheck(on)).then((ok) => ok && toast.success(on ? "The gateway checks for updates on its own" : "The gateway checks only when you ask", { duration: 2000 }))
            }
          />
        </div>
      )}
    </section>
  )
}

/** The command that updates a compose setup, to copy and run on the gateway's server. */
function UpdateCommand({ status, command }: { status: GatewayUpdates; command: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Command copied", { duration: 2000 })
    } catch {
      toast.error("Couldn't reach the clipboard")
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3" data-role="gateway-update">
      <p className="text-sm">
        To update, run this on the gateway's server, in the folder with its <code>compose.yaml</code>:
      </p>
      <InputGroup>
        <InputGroupInput aria-label="Update command" readOnly value={command} onFocus={(e) => e.target.select()} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Copy command" onClick={() => void copy()}>
            <Icon name="content_copy" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <p className="text-xs text-muted-foreground">
        It pulls <code>{status.image}:main</code> (the same build as <code>{status.image}:{status.offered}</code>) and starts the new container on the same data and settings. Back up the
        data volume first. One-click Update and Reload come later, with a small helper on the server's host.
      </p>
      <div>
        <Button size="sm" variant="ghost" render={<a href={status.page} target="_blank" rel="noopener noreferrer" />}>
          <Icon name="open_in_new" data-icon="inline-start" />
          See the build on GitHub
        </Button>
      </div>
    </div>
  )
}
