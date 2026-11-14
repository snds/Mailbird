import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { Button, Icon, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Switch, toast } from "@unicron/ui"
import { setServerUpdating } from "@/app/live-status"
import { type GatewayUpdates, checkGatewayUpdates, gatewayUpdates, peekGatewayUpdates, reloadGateway, setGatewayAutoCheck, updateGateway } from "@/core/client"

const KEY = ["gateway-updates"]

/** How often Settings looks while the gateway restarts, and for how long. */
const FOLLOW_EVERY_MS = 2_000
const FOLLOW_TRIES = 450

/** An Update or Reload Settings is waiting on: the version it started from. */
interface Following {
  from: string
  line: string
  /** Stopped: the last line stays, with a way on when the gateway asked for a sign-in. */
  ended: boolean
  signIn: boolean
}

/**
 * Settings → Gateway updates (ADR-0077), for the gateway's owner: its
 * version and channel, one status line, Check for updates, and the switch
 * for the automatic check. With the host helper set up (ADR-0078), Update
 * (when a newer image is out) and Reload ask it to restart the gateway,
 * and the section waits for the gateway to come back. Without it, the
 * command that takes a newer image, and where to install the helper.
 */
export function GatewayUpdatesSection() {
  const qc = useQueryClient()
  const { data: status, error: loadError } = useQuery({ queryKey: KEY, queryFn: gatewayUpdates, staleTime: 60_000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState<Following | null>(null)
  const followFrom = following && !following.ended ? following.from : null
  // While the gateway restarts, the shell's live status says so on every screen (ADR-0086).
  useEffect(() => {
    setServerUpdating(followFrom !== null)
    return () => setServerUpdating(false)
  }, [followFrom])

  // While an Update or Reload runs, look every two seconds. The gateway goes
  // away (a failed request), then comes back asking for a sign-in (sign-ins
  // live in its memory), or on a new version, or with the helper's refusal.
  useEffect(() => {
    if (!followFrom) return
    let tries = 0
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const say = (line: string, end?: { signIn?: boolean }) => setFollowing({ from: followFrom, line, ended: !!end, signIn: !!end?.signIn })
    const tick = async () => {
      if (stopped) return
      if (++tries > FOLLOW_TRIES) {
        say("This is taking longer than it should. Look at the host helper's log on the host (docker compose logs, in its folder).", {})
        return
      }
      const peek = await peekGatewayUpdates()
      if (stopped) return
      if (peek.kind === "signed-out") {
        say("The gateway restarted. Sign in again to see the version it runs now.", { signIn: true })
        return
      }
      if (peek.kind === "away") {
        say("Reconnecting… the gateway is restarting.")
      } else {
        const now = peek.status
        qc.setQueryData(KEY, now)
        if (now.version !== followFrom) {
          say(`Vale gateway ${now.version} is running.`, {})
          toast.success(`Vale gateway ${now.version} is running`, { duration: 3000 })
          return
        }
        if (now.action && now.action.state !== "working") {
          say(now.action.line, {})
          return
        }
        if (now.action) say(now.action.line)
      }
      timer = setTimeout(() => void tick(), FOLLOW_EVERY_MS)
    }
    timer = setTimeout(() => void tick(), FOLLOW_EVERY_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [followFrom, qc])
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

  /** Asks the host helper, then waits for the gateway to come back. */
  const restart = async (work: () => Promise<GatewayUpdates>) => {
    const from = status.version
    setFollowing(null)
    if (await run(work)) {
      const now = qc.getQueryData<GatewayUpdates>(KEY)
      setFollowing({ from, line: now?.action?.line ?? "Asking the host helper…", ended: false, signIn: false })
    }
  }
  const waiting = !!following && !following.ended
  const lastAction = !following && status.action && status.action.state !== "working" ? status.action : null

  return (
    <section className="flex flex-col gap-3" aria-label="Gateway updates">
      <p className="text-sm">
        Vale gateway {status.version} · {status.channel === "main" ? "main channel (every merged change)" : "stable channel"}
      </p>
      {status.enabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" loading={busy} disabled={status.state === "checking"} onClick={() => void run(checkGatewayUpdates)}>
            <Icon name="renew" data-icon="inline-start" />
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
      {following && (
        <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3" data-role="gateway-restart">
          <p role="status" className="text-sm">
            {following.line}
          </p>
          {waiting && <p className="text-xs text-muted-foreground">The gateway goes away while the host helper works and comes back on its own. Everyone signed in signs in again afterwards.</p>}
          {following.signIn && (
            <div>
              <Button size="sm" onClick={() => location.reload()}>
                <Icon name="login" data-icon="inline-start" />
                Sign in again
              </Button>
            </div>
          )}
        </div>
      )}
      {lastAction && (
        <p role={lastAction.state === "failed" ? "alert" : "status"} className={lastAction.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {lastAction.line}
        </p>
      )}
      {(status.canUpdate || status.canReload) && (
        <div className="flex flex-col gap-2" data-role="gateway-helper-actions">
          <div className="flex flex-wrap items-center gap-2">
            {status.canUpdate && status.offered && (
              <Button size="sm" disabled={busy || waiting} onClick={() => void restart(() => updateGateway(status.offered as string))}>
                <Icon name="download" data-icon="inline-start" />
                Update to {status.offered}
              </Button>
            )}
            {status.canReload && (
              <Button size="sm" variant="outline" disabled={busy || waiting} onClick={() => void restart(reloadGateway)}>
                <Icon name="restart" data-icon="inline-start" />
                Reload
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {status.canUpdate && (
              <>
                Update asks the host helper to pull <code>{status.image}:{status.offered}</code>, checked against the build the release names, and start the gateway on it, on the same data and settings. Back up the data volume first.{" "}
              </>
            )}
            Reload restarts the gateway on the build it runs. Either way the gateway is gone for a moment and everyone signs in again.
          </p>
        </div>
      )}
      {!status.helper.ready && status.state === "available" && status.command && <UpdateCommand status={status} command={status.command} />}
      {!status.helper.ready && (
        <p className="text-xs text-muted-foreground">
          {status.helper.problem && <span className="text-destructive">The host helper's settings aren't usable: {status.helper.problem} </span>}
          One-click Update and Reload need the host helper beside the gateway:{" "}
          <a className="underline underline-offset-2" href={status.helper.install} target="_blank" rel="noopener noreferrer">
            its install steps
          </a>
          .
        </p>
      )}
      {status.checkedAt && <p className="text-xs text-muted-foreground">Last checked {new Date(status.checkedAt * 1000).toLocaleString()}.</p>}
      {status.enabled && (
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 id="gateway-update-auto-heading" className="text-sm font-medium">
              Check for updates automatically
            </h3>
            <p className="text-xs text-muted-foreground">When the gateway starts and every six hours. It only looks: nothing is downloaded or restarted until you press Update.</p>
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
            <Icon name="copy" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <p className="text-xs text-muted-foreground">
        It pulls <code>{status.image}:main</code> (the same build as <code>{status.image}:{status.offered}</code>) and starts the new container on the same data and settings. Back up the
        data volume first.
      </p>
      <div>
        <Button size="sm" variant="ghost" render={<a href={status.page} target="_blank" rel="noopener noreferrer" />}>
          <Icon name="launch" data-icon="inline-start" />
          See the build on GitHub
        </Button>
      </div>
    </div>
  )
}
