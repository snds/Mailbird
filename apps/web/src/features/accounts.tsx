import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { getCoreClient } from "@/core/client"
import { useAccounts, useCore } from "@/core/queries"
import type { AccountConfig, Provider, Security, ServerConfig } from "@/core/types"
import { longTime } from "@/lib/time"

interface Preset {
  id: string
  label: string
  icon: IconName
  provider: Provider
  /** Why it can't be added yet. Shown instead of hiding the option. */
  unavailable?: string
  imap?: ServerConfig
  smtp?: ServerConfig
  passwordLabel: string
  passwordHelp?: { text: string; href: string }
}

const PRESETS: Preset[] = [
  {
    id: "icloud", label: "iCloud", icon: "cloud", provider: "i_cloud",
    imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "start_tls" },
    passwordLabel: "App-specific password",
    passwordHelp: { text: "Create one at account.apple.com → Sign-In and Security.", href: "https://support.apple.com/102654" },
  },
  {
    id: "fastmail", label: "Fastmail", icon: "bolt", provider: "generic",
    imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
    passwordLabel: "App password",
    passwordHelp: { text: "Create one in Fastmail → Settings → Privacy & Security.", href: "https://www.fastmail.help/hc/en-us/articles/360058752854" },
  },
  {
    id: "other", label: "Other (IMAP)", icon: "dns", provider: "generic",
    imap: { host: "", port: 993, security: "tls" },
    smtp: { host: "", port: 465, security: "tls" },
    passwordLabel: "Password",
  },
  { id: "google", label: "Gmail", icon: "mail", provider: "google", passwordLabel: "", unavailable: "Needs Google sign-in and app verification — planned for a later release." },
  { id: "microsoft", label: "Outlook / Microsoft 365", icon: "mail", provider: "microsoft", passwordLabel: "", unavailable: "Needs Microsoft sign-in — planned for a later release." },
]

export function AccountsDialog() {
  const open = useUi((s) => s.accountsOpen)
  const setOpen = useUi((s) => s.setAccountsOpen)
  const [preset, setPreset] = useState<Preset | null>(null)

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), !o && setPreset(null))}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {preset ? <AddAccountForm preset={preset} onBack={() => setPreset(null)} onDone={() => setPreset(null)} /> : <AccountList onAdd={setPreset} />}
      </DialogContent>
    </Dialog>
  )
}

function AccountList({ onAdd }: { onAdd: (p: Preset) => void }) {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: async (id: string) => (await getCoreClient()).removeAccount(id),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Accounts</DialogTitle>
        <DialogDescription>Mail stays on this device. Passwords are kept in your system keychain.</DialogDescription>
      </DialogHeader>

      {core?.kind === "demo" && (
        <p className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Icon name="info" className="mt-0.5 size-4 shrink-0" />
          You're using the web preview with sample mail. Connecting real accounts needs the desktop app for now.
        </p>
      )}

      {accounts.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <Icon name="alternate_email" className="size-5 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{a.displayName}</span>
                <span className="truncate text-xs text-muted-foreground">{a.address}</span>
                {a.lastError ? (
                  <span className="text-xs text-destructive">Sync problem: {a.lastError}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{a.lastSync ? `Synced ${longTime(a.lastSync)}` : "Waiting for first sync"}</span>
                )}
              </div>
              {core?.kind === "native" && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${a.displayName}`} onClick={() => confirm(`Remove ${a.address} from this device? Mail on the server is not affected.`) && remove.mutate(a.id)}>
                  <Icon name="delete" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Add an account</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!!p.unavailable || core?.kind === "demo"}
              onClick={() => onAdd(p)}
              className="flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <Icon name={p.icon} className="mt-0.5 size-5 text-muted-foreground" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{p.label}</span>
                {p.unavailable && <span className="text-xs text-muted-foreground">{p.unavailable}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

const SECURITY: { value: Security; label: string }[] = [
  { value: "tls", label: "SSL/TLS" },
  { value: "start_tls", label: "STARTTLS" },
  { value: "plain", label: "None (this computer only)" },
]

function ServerFields({ label, value, onChange, idPrefix }: { label: string; value: ServerConfig; onChange: (v: ServerConfig) => void; idPrefix: string }) {
  return (
    <fieldset className="grid grid-cols-[1fr_6rem] gap-2">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <Input aria-label={`${label} server`} placeholder="mail.example.com" value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} id={`${idPrefix}-host`} autoCapitalize="none" />
      <Input aria-label={`${label} port`} inputMode="numeric" value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
      <NativeSelect aria-label={`${label} security`} value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as Security })} className="col-span-2 w-full">
        {SECURITY.map((s) => (
          <NativeSelectOption key={s.value} value={s.value}>
            {s.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </fieldset>
  )
}

function AddAccountForm({ preset, onBack, onDone }: { preset: Preset; onBack: () => void; onDone: () => void }) {
  const [address, setAddress] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [username, setUsername] = useState("")
  const [imap, setImap] = useState(preset.imap!)
  const [smtp, setSmtp] = useState(preset.smtp!)
  const custom = preset.id === "other"
  const qc = useQueryClient()

  const add = useMutation({
    mutationFn: async () => {
      const config: AccountConfig = {
        displayName: displayName.trim() || address.split("@")[0]!,
        address: address.trim(),
        username: (username || address).trim(),
        provider: preset.provider,
        imap,
        smtp,
      }
      return (await getCoreClient()).addAccount(config, password)
    },
    onSuccess: (a) => {
      void qc.invalidateQueries()
      toast.success(`${a.address} added — fetching mail`)
      onDone()
    },
  })

  return (
    <form onSubmit={(e) => (e.preventDefault(), add.mutate())} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
            <Icon name="arrow_back" />
          </Button>
          Add {preset.label}
        </DialogTitle>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="acct-address">Email address</FieldLabel>
          <Input id="acct-address" type="email" required autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="acct-name">Name on sent mail</FieldLabel>
          <Input id="acct-name" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
        </Field>
        {custom && (
          <Field>
            <FieldLabel htmlFor="acct-user">Username</FieldLabel>
            <Input id="acct-user" placeholder="Usually your email address" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="acct-password">{preset.passwordLabel}</FieldLabel>
          <Input id="acct-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {preset.passwordHelp && (
            <FieldDescription>
              {preset.passwordHelp.text}{" "}
              <a href={preset.passwordHelp.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                How
              </a>
            </FieldDescription>
          )}
        </Field>
        {custom && (
          <>
            <ServerFields label="Incoming (IMAP)" value={imap} onChange={setImap} idPrefix="imap" />
            <ServerFields label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} idPrefix="smtp" />
          </>
        )}
      </FieldGroup>

      {add.error && (
        <p role="alert" className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <Icon name="error" className="mt-0.5 size-4 shrink-0" /> {add.error.message}
        </p>
      )}
      <DialogFooter>
        <Badge variant="outline" className="mr-auto self-center">
          <Icon name="lock" className="size-3" /> Checked before saving
        </Badge>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? "Connecting…" : "Add account"}
        </Button>
      </DialogFooter>
    </form>
  )
}
