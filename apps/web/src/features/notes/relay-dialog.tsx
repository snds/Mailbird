import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import {
  Icon,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  SecretField,
  type SecretFieldHost,
} from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useNotesRelay } from "@/core/queries"
import type { RelayConfig } from "@/core/types"

import { isKey, newKey } from "./sealed"
import { relayUrlProblem, useSyncStatus } from "./sync"

export function RelayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">{open && <RelayForm onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function RelayForm({ onDone }: { onDone: () => void }) {
  const { data: relay } = useNotesRelay()
  const status = useSyncStatus()
  const [url, setUrl] = useState(relay?.url ?? "")
  const [token, setToken] = useState(relay?.token ?? "")
  const [key, setKey] = useState(relay?.key ?? "")
  const [tried, setTried] = useState(false)
  const [encrypting, setEncrypting] = useState(false)
  // Replacing a saved key, say one pasted wrong.
  const [changingKey, setChangingKey] = useState(false)
  const qc = useQueryClient()
  const problem = url.trim() ? relayUrlProblem(url.trim()) : "Enter the relay’s address"
  const keyProblem = key.trim() && !isKey(key) ? "That isn't a whole key. Copy it again from a device that has it." : null
  // The relay said it's sealed and this device has no key: that's the field to fill.
  const needsKey = !relay?.key && status.status === "error" && !!status.error?.includes("end-to-end")

  const save = async (value: RelayConfig | null, said?: string) => {
    try {
      await (await getCoreClient()).setNotesRelay(value)
      await qc.invalidateQueries({ queryKey: ["notes", "relay"] })
      toast.success(said ?? (value ? "Notes will sync through this relay" : "Notes sync is off"), { duration: 2500 })
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (encrypting && relay) return <TurnOnEncryption relay={relay} onBack={() => setEncrypting(false)} save={save} />

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        // An empty key field keeps the key this device has: emptying it never turns encryption off.
        if (!problem && !keyProblem) void save({ url: url.trim(), token: token.trim(), key: key.trim() || relay?.key || null })
      }}
    >
      <DialogHeader>
        <DialogTitle>Sync notes between devices</DialogTitle>
        <DialogDescription>
          Notes sync through a relay you run (or one you trust). Edits merge as you type, even offline. Mail, calendar, and contacts sync with
          your accounts instead.
        </DialogDescription>
      </DialogHeader>

      {relay && (
        <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm" role="status">
          <Icon name={status.status === "error" ? "sync_problem" : "cloud_done"} className="size-4" />
          {status.status === "synced" ? "Connected and up to date" : status.status === "error" ? status.error : "Connecting…"}
        </p>
      )}

      <Field data-invalid={tried && !!problem}>
        <FieldLabel htmlFor="relay-url">Relay address</FieldLabel>
        <Input id="relay-url" inputMode="url" autoComplete="off" placeholder="wss://notes.example.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={tried && !!problem} />
        {tried && problem ? <FieldError>{problem}</FieldError> : <FieldDescription>Any Hocuspocus-compatible server works, like the one in tools/notes-relay.</FieldDescription>}
      </Field>
      <Field>
        <FieldLabel htmlFor="relay-token">Access token</FieldLabel>
        <Input id="relay-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        <FieldDescription>Kept in your system keychain. Use the same token on each device.</FieldDescription>
      </Field>
      {relay?.key && !changingKey ? (
        <SecretField
          label="Encryption key"
          getSecret={async () => new TextEncoder().encode(relay.key!)}
          host={clipboardHost}
          // Long enough to paste it on another device; the clipboard clears after.
          clipboardTimer={90}
          description={
            <>
              End-to-end encrypted: only your devices can read your notes. Copy this key to each one that syncs.{" "}
              <Button type="button" variant="link" size="inline" onClick={() => (setKey(""), setChangingKey(true))}>
                Use a different key
              </Button>
            </>
          }
        />
      ) : (
        <>
          <SecretField
            mode="edit"
            id="relay-key"
            label="Encryption key"
            value={key}
            onChange={setKey}
            error={keyProblem ?? (needsKey ? "This relay is end-to-end encrypted. Paste the key from a device that syncs with it." : undefined)}
            description={relay?.key ? "Paste the key from a device that syncs with this relay." : "Only if another of your devices turned on end-to-end encryption. Copy its key here."}
          />
          {relay && !relay.key && !needsKey && (
            <p className="flex gap-2 text-xs text-muted-foreground">
              <Icon name="info" className="mt-0.5 size-4" />
              <span>
                The relay can read your notes: they're encrypted on the way, not end to end.{" "}
                <Button type="button" variant="link" size="inline" onClick={() => setEncrypting(true)}>
                  Turn on end-to-end encryption
                </Button>
              </span>
            </p>
          )}
        </>
      )}

      <DialogFooter>
        {relay && (
          <Button type="button" variant="ghost" className="mr-auto" onClick={() => void save(null)}>
            Turn off sync
          </Button>
        )}
        <Button type="submit">{relay ? "Save" : "Turn on sync"}</Button>
      </DialogFooter>
    </form>
  )
}

/**
 * The key's clipboard (unicron SecretField): copied as text, cleared when the
 * timer ends. The page can't read the clipboard back without asking, so the
 * clear runs even if something else was copied since; the field says so.
 */
const clipboardHost: SecretFieldHost = {
  copy: (bytes) => navigator.clipboard.writeText(new TextDecoder().decode(bytes)),
  clear: () => navigator.clipboard.writeText(""),
}

/**
 * Turning on end-to-end encryption (ADR-0062): what changes, before it does.
 * Links shared before stop working, since the relay could read them; your
 * notes upload sealed, and the relay drops its readable copies.
 */
function TurnOnEncryption({ relay, onBack, save }: { relay: RelayConfig; onBack: () => void; save: (r: RelayConfig, said: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const turnOn = async () => {
    setBusy(true)
    try {
      const c = await getCoreClient()
      for (const r of await c.noteRecords()) if (!r.deleted && r.share?.role === "owner" && !r.share.revoked && !r.share.key) await c.unshareNote(r.id)
      for (const t of await c.teamThreads()) if (t.role === "owner" && !t.revoked && !t.key) await c.stopTeamThread(t.id)
      // An open note that was shared moves off its old document now, not on its next refresh.
      await qc.invalidateQueries({ queryKey: ["notes"] })
      await save({ ...relay, key: newKey() }, "Notes are end-to-end encrypted now")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Turn on end-to-end encryption?</DialogTitle>
        <DialogDescription>Only your devices will be able to read your notes. The relay keeps them, but can't open them.</DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-2 text-sm">
        <li className="flex gap-2">
          <span className="mt-0.5 shrink-0 [&>svg]:size-4">
            <Icon name="key" tone="muted" />
          </span>
          You'll get a key. Each of your other devices needs it to keep syncing, so copy it there.
        </li>
        <li className="flex gap-2">
          <span className="mt-0.5 shrink-0 [&>svg]:size-4">
            <Icon name="link_off" tone="muted" />
          </span>
          Notes and conversations you've shared stop working. Share them again for a link that's encrypted too.
        </li>
        <li className="flex gap-2">
          <span className="mt-0.5 shrink-0 [&>svg]:size-4">
            <Icon name="delete" tone="muted" />
          </span>
          The relay deletes the readable copies it has. It can't go back to readable sync.
        </li>
      </ul>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void turnOn()} disabled={busy}>
          {busy ? "Turning on…" : "Turn on"}
        </Button>
      </DialogFooter>
    </div>
  )
}
