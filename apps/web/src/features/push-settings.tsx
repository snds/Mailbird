import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getCoreClient } from "@/core/client"
import type { PushAccount, PushMode, PushSettings } from "@/core/types"
import { cn } from "@/lib/utils"

const GUIDE = "https://github.com/snds/Mailbird/blob/main/tools/push-relay/README.md"

const CHOICES: { mode: PushMode; title: string; text: string }[] = [
  {
    mode: "periodic",
    title: "Check on the phone's schedule",
    text: "No server needed. iOS and Android decide how often the app may check, usually every 15 minutes to a few hours.",
  },
  {
    mode: "relay",
    title: "Instant, through your relay",
    text: "A small server you run yourself (Docker) watches your mailboxes and wakes this phone within seconds. It holds your app passwords.",
  },
]

/**
 * How new mail reaches this device when the app isn't open (ADR-0015):
 * the phone's own background checks, or a self-hosted push relay.
 */
export function PushSettingsSection() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ["push-settings"], queryFn: async () => (await getCoreClient()).getPushSettings() })
  const [mode, setMode] = useState<PushMode | null>(null)
  const chosen = mode ?? data?.mode ?? "periodic"

  const save = useMutation({
    mutationFn: async (input: Parameters<Awaited<ReturnType<typeof getCoreClient>>["setPushSettings"]>[0]) => (await getCoreClient()).setPushSettings(input),
    onSuccess: (s) => {
      qc.setQueryData(["push-settings"], s)
      setMode(null)
      toast.success(s.mode === "relay" ? "This device now gets new mail through your relay" : "This device checks for mail on its own schedule")
    },
  })
  const test = useMutation({
    mutationFn: async () => (await getCoreClient()).sendTestPush(),
    onSuccess: () => toast.success("Test sent — it should arrive within a few seconds"),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (!data) return null
  return (
    <section className="flex flex-col gap-3" aria-labelledby="push-heading">
      <div className="flex flex-col gap-0.5">
        <h3 id="push-heading" className="text-sm font-medium">
          New mail on this phone
        </h3>
        <p className="text-xs text-muted-foreground">How mail arrives while the app is closed. The desktop app keeps its own connection open while it runs.</p>
      </div>
      <div role="radiogroup" aria-labelledby="push-heading" className="grid gap-2 sm:grid-cols-2">
        {CHOICES.map((c) => (
          <label
            key={c.mode}
            className={cn("flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors hover:bg-accent", chosen === c.mode && "border-primary bg-accent/60")}
          >
            <input type="radio" name="push-mode" value={c.mode} checked={chosen === c.mode} onChange={() => setMode(c.mode)} className="mt-1 accent-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{c.title}</span>
              <span className="text-xs text-muted-foreground">{c.text}</span>
            </span>
          </label>
        ))}
      </div>

      {chosen === "periodic" && data.mode === "relay" && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate({ mode: "periodic" })} disabled={save.isPending}>
            Stop using the relay
          </Button>
        </div>
      )}
      {chosen === "relay" && <RelayForm data={data} saving={save.isPending} onSave={(input) => save.mutate({ mode: "relay", ...input })} error={save.error} />}
      {save.error && chosen === "periodic" && (
        <p className="text-sm text-destructive" role="alert">
          {save.error instanceof Error ? save.error.message : String(save.error)}
        </p>
      )}

      {data.mode === "relay" && chosen === "relay" && (
        <>
          {data.error && (
            <p className="text-sm text-destructive" role="alert">
              The relay didn't answer: {data.error}
            </p>
          )}
          <ul className="flex flex-col divide-y rounded-xl border" aria-label="Accounts on the relay">
            {data.accounts.map((a) => (
              <AccountStatus key={a.accountId} account={a} />
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
              <Icon name="notifications_active" data-icon="inline-start" /> Send a test
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

function RelayForm({ data, saving, onSave, error }: { data: PushSettings; saving: boolean; onSave: (v: { relayUrl: string; relayToken: string | null; unifiedPushEndpoint: string | null }) => void; error: unknown }) {
  const [url, setUrl] = useState(data.relayUrl ?? "")
  const [token, setToken] = useState("")
  const [endpoint, setEndpoint] = useState(data.unifiedPushEndpoint ?? "")
  const saved = data.mode === "relay"
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border px-3 py-3"
      onSubmit={(e) => (e.preventDefault(), onSave({ relayUrl: url.trim(), relayToken: token.trim() || null, unifiedPushEndpoint: endpoint.trim() || null }))}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="relay-url">Relay address</FieldLabel>
          <Input id="relay-url" type="url" required inputMode="url" autoCapitalize="none" placeholder="https://relay.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <FieldDescription>
            Run it on a home server or a small VPS, behind https.{" "}
            <a href={GUIDE} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Set-up guide
            </a>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="relay-token">Relay token</FieldLabel>
          <Input id="relay-token" type="password" autoComplete="off" required={!saved} placeholder={saved ? "Saved — leave empty to keep it" : undefined} value={token} onChange={(e) => setToken(e.target.value)} />
          <FieldDescription>The RELAY_TOKEN you set on the relay. Kept in this device's keychain.</FieldDescription>
        </Field>
        {!data.platformPush && (
          <Field>
            <FieldLabel htmlFor="relay-endpoint">UnifiedPush address</FieldLabel>
            <Input id="relay-endpoint" type="url" inputMode="url" autoCapitalize="none" placeholder="https://ntfy.sh/your-private-topic" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            <FieldDescription>This device has no push service of its own yet. Android without Google can use ntfy or another UnifiedPush app; phone builds fill this in themselves.</FieldDescription>
          </Field>
        )}
      </FieldGroup>
      {error != null && (
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving || !url.trim()}>
          {saved ? "Save relay settings" : "Connect to relay"}
        </Button>
      </div>
    </form>
  )
}

function AccountStatus({ account: a }: { account: PushAccount }) {
  const s = a.status
  const [label, tone] = a.via === "periodic" ? ["Phone's schedule", "secondary"] : s?.error ? ["Needs attention", "destructive"] : s ? ["Instant", "default"] : ["Waiting for the relay", "secondary"]
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{a.address}</span>
        <Badge variant={tone as "default" | "secondary" | "destructive"}>{label}</Badge>
      </div>
      {a.note && <span className="text-xs text-muted-foreground">{a.note}</span>}
      {s?.error && <span className="text-xs text-destructive">{s.error}</span>}
    </li>
  )
}
