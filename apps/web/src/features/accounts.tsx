import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldGroup, FieldLabel, Input, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, NativeSelect, NativeSelectOption } from "@unicron/ui"
import { getCoreClient, signOutOfGateway } from "@/core/client"
import { useAccounts, useCore } from "@/core/queries"
import type { Account, AccountConfig, DavConfig, JmapConfig, OAuthIssuer, Provider, Security, ServerConfig } from "@/core/types"
import { longTime } from "@/lib/time"

import { OAuthSignIn } from "./oauth-sign-in"
import { PushSettingsSection } from "./push-settings"
import { MeetingSettingsSection } from "./meeting-settings"
import { MenuBarSettingsSection } from "./menu-bar-settings"
import { ScreenerSettingsSection } from "./screener-settings"

interface Preset {
  id: string
  label: string
  icon: IconName
  provider: Provider
  /** Why it can't be added yet. Shown instead of hiding the option. */
  unavailable?: string
  /** Signs in on the provider's page in the browser instead of a form. */
  oauth?: OAuthIssuer
  imap?: ServerConfig
  smtp?: ServerConfig
  /** JMAP accounts sync and send over HTTPS; no IMAP/SMTP needed. */
  jmap?: JmapConfig
  /** Which server fields the form asks for. */
  custom?: "imap" | "jmap"
  passwordLabel: string
  passwordHelp?: { text: string; href: string }
  /** Calendars and contacts. `ask` lets people enter their own servers. */
  dav?: DavConfig | "ask"
  /** Help for a separate calendar app password (`dav.separateSecret`). */
  davPasswordHelp?: { text: string; href: string }
}

const PRESETS: Preset[] = [
  {
    id: "icloud", label: "iCloud", icon: "cloud", provider: "i_cloud",
    imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "start_tls" },
    passwordLabel: "App-specific password",
    passwordHelp: { text: "Create one at account.apple.com → Sign-In and Security.", href: "https://support.apple.com/102654" },
    // The same app-specific password covers iCloud Calendar and Contacts.
    dav: { calendarUrl: "https://caldav.icloud.com/", contactsUrl: "https://contacts.icloud.com/" },
  },
  {
    id: "fastmail", label: "Fastmail", icon: "bolt", provider: "jmap",
    // Fastmail is the JMAP reference server: faster sync, no IMAP/SMTP.
    jmap: { sessionUrl: "https://api.fastmail.com/jmap/session", bearer: true },
    passwordLabel: "API token",
    passwordHelp: { text: "In Fastmail: Settings → Privacy & Security → Connected apps & API tokens. Choose JMAP and allow Email and Email submission. (Not available on Basic plans.)", href: "https://www.fastmail.help/hc/en-us/articles/5254602856719" },
    // API tokens can't do CalDAV, so calendars need a separate app password.
    dav: { calendarUrl: "https://caldav.fastmail.com/", contactsUrl: "https://carddav.fastmail.com/", separateSecret: true },
    davPasswordHelp: { text: "Optional. In Fastmail: Settings → Privacy & Security → App passwords, with access to calendars and contacts.", href: "https://www.fastmail.help/hc/en-us/articles/1500000278342" },
  },
  {
    id: "other", label: "Other (IMAP)", icon: "dns", provider: "generic", custom: "imap",
    imap: { host: "", port: 993, security: "tls" },
    smtp: { host: "", port: 465, security: "tls" },
    passwordLabel: "Password",
    dav: "ask",
  },
  {
    id: "jmap", label: "Other (JMAP)", icon: "api", provider: "jmap", custom: "jmap",
    jmap: { sessionUrl: "", bearer: false },
    passwordLabel: "Password",
    dav: "ask",
  },
  { id: "google", label: "Gmail", icon: "mail", provider: "google", passwordLabel: "", oauth: "google" },
  { id: "microsoft", label: "Outlook / Microsoft 365", icon: "mail", provider: "microsoft", passwordLabel: "", oauth: "microsoft" },
]

export function AccountsDialog() {
  const open = useUi((s) => s.accountsOpen)
  const setOpen = useUi((s) => s.setAccountsOpen)
  const [preset, setPreset] = useState<Preset | null>(null)
  const [connecting, setConnecting] = useState<Account | null>(null)

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), !o && setPreset(null))}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {preset?.oauth ? (
          <OAuthSignIn issuer={preset.oauth} onBack={() => setPreset(null)} onDone={() => setPreset(null)} />
        ) : preset ? (
          <AddAccountForm preset={preset} onBack={() => setPreset(null)} onDone={() => setPreset(null)} />
        ) : connecting ? (
          <ConnectDavForm account={connecting} onDone={() => setConnecting(null)} />
        ) : (
          <AccountList onAdd={setPreset} onConnect={setConnecting} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function AccountList({ onAdd, onConnect }: { onAdd: (p: Preset) => void; onConnect: (a: Account) => void }) {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: async (id: string) => (await getCoreClient()).removeAccount(id),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(e.message),
  })
  // An OAuth account whose sign-in expired or was revoked: sign in again in the browser.
  const reauth = useMutation({
    mutationFn: async (id: string) => (await getCoreClient()).reauthOAuthAccount(id),
    onSuccess: (a) => {
      void qc.invalidateQueries()
      toast.success(`${a.address} is connected again`)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Accounts</DialogTitle>
        <DialogDescription>
          {core?.remote ? "Mail is kept on your gateway. Passwords are sealed there with its key." : "Mail stays on this device. Passwords are kept in your system keychain."}
        </DialogDescription>
      </DialogHeader>

      {core?.kind === "demo" && (
        <p className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Icon name="info" className="mt-0.5 size-4" />
          You're using the web preview with sample mail. Connecting real accounts needs the desktop app for now.
        </p>
      )}

      {accounts.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <Icon name="alternate_email" tone="muted" className="size-5" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{a.displayName}</span>
                <span className="truncate text-xs text-muted-foreground">{a.address}</span>
                {a.lastError ? (
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-destructive">
                    Sync problem: {a.lastError}
                    {a.oauth && core?.kind === "native" && (
                      <Button variant="link" size="inline" disabled={reauth.isPending} onClick={() => reauth.mutate(a.id)}>
                        {reauth.isPending && reauth.variables === a.id ? "Waiting for the browser…" : "Sign in again"}
                      </Button>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">{a.lastSync ? `Synced ${longTime(a.lastSync)}` : "Waiting for first sync"}</span>
                )}
                {a.dav ? (
                  a.davError ? (
                    <span className="text-xs text-destructive">Calendars and contacts: {a.davError}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Calendars and contacts {a.davLastSync ? `synced ${longTime(a.davLastSync)}` : "connecting"}</span>
                  )
                ) : (
                  core?.kind === "native" && (
                    <span className="text-xs">
                      <Button variant="link" size="inline" onClick={() => onConnect(a)}>
                        Connect calendars and contacts
                      </Button>
                    </span>
                  )
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
          {PRESETS.map((preset) => {
            const p = core?.remote && preset.oauth && !SAME_COMPUTER ? { ...preset, unavailable: OAUTH_REMOTE } : preset
            return (
              <Item key={p.id} variant="outline" render={<button type="button" disabled={!!p.unavailable || (core?.kind === "demo" && !p.oauth)} onClick={() => onAdd(p)} />}>
                <ItemMedia>
                  <Icon name={p.icon} tone="muted" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{p.label}</ItemTitle>
                  {p.unavailable && <ItemDescription>{p.unavailable}</ItemDescription>}
                </ItemContent>
              </Item>
            )
          })}
        </div>
      </div>

      {accounts.length > 0 && (
        <SettingsRow icon="edit_note" title="Signatures and templates" hint="What goes at the end of your messages, and text you reuse." open={() => useUi.getState().setWritingOpen(true)} />
      )}

      <SettingsRow icon="swipe" title="Shortcuts and gestures" hint="What your swipes do, and the keys for everything." open={() => useUi.getState().setGrammarOpen(true)} />

      {accounts.length > 0 && (
        <SettingsRow icon="tune" title="Advanced mail settings" hint="Remote images, marking read, how replies quote, read receipts, and how often to check." open={() => useUi.getState().setAdvancedMailOpen(true)} />
      )}

      {accounts.length > 0 && (
        <SettingsRow icon="wand_stars" title="AI summaries and replies" hint="Off unless you turn it on: a model on this computer, or Claude or another service with your own key." open={() => useUi.getState().setAiSettingsOpen(true)} />
      )}

      <MeetingSettingsSection />

      {/* The menu bar is the desktop's; the demo stands in for it. */}
      {!core?.remote && <MenuBarSettingsSection />}

      {accounts.length > 0 && <ScreenerSettingsSection />}

      {accounts.length > 0 && !core?.remote && <PushSettingsSection />}
      {core?.remote && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void signOutOfGateway().then(() => location.reload())}>
            <Icon name="logout" data-icon="inline-start" /> Sign out of this gateway
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * Provider sign-in returns to a page on the computer running the app. Behind
 * a gateway that's the server, so it only works when the browser is there too.
 */
const SAME_COMPUTER = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
const OAUTH_REMOTE = "Sign in from the desktop app, or open the gateway on its own computer"

/** JMAP accounts carry no IMAP/SMTP settings. */
const UNUSED: ServerConfig = { host: "", port: 0, security: "tls" }

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
  const [imap, setImap] = useState(preset.imap ?? UNUSED)
  const [smtp, setSmtp] = useState(preset.smtp ?? UNUSED)
  const [sessionUrl, setSessionUrl] = useState(preset.jmap?.sessionUrl ?? "")
  const [davPassword, setDavPassword] = useState("")
  const [calendarUrl, setCalendarUrl] = useState("")
  const [contactsUrl, setContactsUrl] = useState("")
  const custom = preset.custom
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
        jmap: preset.jmap ? { sessionUrl: sessionUrl.trim(), bearer: preset.jmap.bearer } : null,
        dav: davFor(preset, calendarUrl, contactsUrl, davPassword),
      }
      return (await getCoreClient()).addAccount(config, password, davPassword || null)
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
        <DialogTitle>
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
        {custom === "jmap" && (
          <Field>
            <FieldLabel htmlFor="acct-session">JMAP session URL</FieldLabel>
            <Input id="acct-session" type="url" required placeholder="https://mail.example.com/jmap/session" value={sessionUrl} onChange={(e) => setSessionUrl(e.target.value)} autoCapitalize="none" />
            <FieldDescription>Often https://your-server/.well-known/jmap</FieldDescription>
          </Field>
        )}
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
        {custom === "imap" && (
          <>
            <ServerFields label="Incoming (IMAP)" value={imap} onChange={setImap} idPrefix="imap" />
            <ServerFields label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} idPrefix="smtp" />
          </>
        )}
        {typeof preset.dav === "object" && preset.dav.separateSecret && (
          <Field>
            <FieldLabel htmlFor="acct-dav-password">App password for calendars and contacts</FieldLabel>
            <Input id="acct-dav-password" type="password" value={davPassword} onChange={(e) => setDavPassword(e.target.value)} autoComplete="off" />
            {preset.davPasswordHelp && (
              <FieldDescription>
                {preset.davPasswordHelp.text}{" "}
                <a href={preset.davPasswordHelp.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  How
                </a>
              </FieldDescription>
            )}
          </Field>
        )}
        {preset.dav === "ask" && <DavUrlFields calendarUrl={calendarUrl} setCalendarUrl={setCalendarUrl} contactsUrl={contactsUrl} setContactsUrl={setContactsUrl} />}
        {typeof preset.dav === "object" && !preset.dav.separateSecret && (
          <p className="flex gap-2 text-xs text-muted-foreground">
            <Icon name="calendar_month" className="size-4" /> Calendars and contacts connect with the same password.
          </p>
        )}
      </FieldGroup>

      {add.error && (
        <p role="alert" className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <Icon name="error" className="mt-0.5 size-4" /> {add.error.message}
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

/** The DAV part of a new account: preset servers, typed ones, or none. */
function davFor(preset: Preset, calendarUrl: string, contactsUrl: string, davPassword: string): DavConfig | null {
  if (preset.dav === "ask") {
    const cal = calendarUrl.trim() || null
    const card = contactsUrl.trim() || null
    return cal || card ? { calendarUrl: cal, contactsUrl: card } : null
  }
  if (!preset.dav) return null
  // A separate-secret preset only connects when that password was given.
  return preset.dav.separateSecret && !davPassword ? null : preset.dav
}

function DavUrlFields({ calendarUrl, setCalendarUrl, contactsUrl, setContactsUrl }: { calendarUrl: string; setCalendarUrl: (v: string) => void; contactsUrl: string; setContactsUrl: (v: string) => void }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="acct-caldav">Calendar server (CalDAV)</FieldLabel>
        <Input id="acct-caldav" type="url" placeholder="https://dav.example.com/" value={calendarUrl} onChange={(e) => setCalendarUrl(e.target.value)} autoCapitalize="none" />
        <FieldDescription>Optional. The server address is enough; we find your calendars from there.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="acct-carddav">Contacts server (CardDAV)</FieldLabel>
        <Input id="acct-carddav" type="url" placeholder="https://dav.example.com/" value={contactsUrl} onChange={(e) => setContactsUrl(e.target.value)} autoCapitalize="none" />
      </Field>
    </>
  )
}

/** Adds calendars and contacts to an account that only has mail. */
function ConnectDavForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const preset = PRESETS.find((p) => p.provider === account.provider && typeof p.dav === "object" && (p.jmap ? !!account.jmap : !account.jmap))
  const fixed = preset && typeof preset.dav === "object" ? preset.dav : null
  const [calendarUrl, setCalendarUrl] = useState(fixed?.calendarUrl ?? "")
  const [contactsUrl, setContactsUrl] = useState(fixed?.contactsUrl ?? "")
  // Without a preset, JMAP accounts (API tokens) need their own DAV password.
  const separate = fixed?.separateSecret ?? !!account.jmap
  const [password, setPassword] = useState("")
  const qc = useQueryClient()
  const connect = useMutation({
    mutationFn: async () => {
      const dav: DavConfig = { calendarUrl: calendarUrl.trim() || null, contactsUrl: contactsUrl.trim() || null, separateSecret: separate }
      if (!dav.calendarUrl && !dav.contactsUrl) throw new Error("Enter a calendar or contacts server.")
      return (await getCoreClient()).setAccountDav(account.id, dav, password || null)
    },
    onSuccess: () => {
      void qc.invalidateQueries()
      toast.success("Calendars and contacts connected — syncing")
      onDone()
    },
  })
  return (
    <form onSubmit={(e) => (e.preventDefault(), connect.mutate())} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onDone} aria-label="Back">
            <Icon name="arrow_back" />
          </Button>
          Calendars and contacts
        </DialogTitle>
        <DialogDescription>{account.address}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {!fixed && <DavUrlFields calendarUrl={calendarUrl} setCalendarUrl={setCalendarUrl} contactsUrl={contactsUrl} setContactsUrl={setContactsUrl} />}
        <Field>
          <FieldLabel htmlFor="dav-password">{separate ? "App password for calendars and contacts" : "Password"}</FieldLabel>
          <Input id="dav-password" type="password" required={separate} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          <FieldDescription>
            {separate ? (preset?.davPasswordHelp?.text ?? "This server needs its own password for calendars.") : "Leave blank to use the account's saved password."}
          </FieldDescription>
        </Field>
      </FieldGroup>
      {connect.error && (
        <p role="alert" className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <Icon name="error" className="mt-0.5 size-4" /> {connect.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={connect.isPending}>
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** A row that opens a settings dialog of its own, closing this one. */
function SettingsRow({ icon, title, hint, open }: { icon: IconName; title: string; hint: string; open: () => void }) {
  return (
    <Item variant="outline" render={<button type="button" onClick={() => (useUi.getState().setAccountsOpen(false), open())} />}>
      <ItemMedia>
        <Icon name={icon} tone="muted" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{hint}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Icon name="chevron_right" tone="muted" />
      </ItemActions>
    </Item>
  )
}
