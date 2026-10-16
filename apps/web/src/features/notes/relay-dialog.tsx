import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldError, FieldLabel, Input } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useNotesRelay } from "@/core/queries"

import { relayUrlProblem, useSyncStatus } from "./sync"

export function RelayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open && <RelayForm onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function RelayForm({ onDone }: { onDone: () => void }) {
  const { data: relay } = useNotesRelay()
  const status = useSyncStatus()
  const [url, setUrl] = useState(relay?.url ?? "")
  const [token, setToken] = useState(relay?.token ?? "")
  const [tried, setTried] = useState(false)
  const qc = useQueryClient()
  const problem = url.trim() ? relayUrlProblem(url.trim()) : "Enter the relay’s address"

  const save = async (value: { url: string; token: string } | null) => {
    try {
      await (await getCoreClient()).setNotesRelay(value)
      await qc.invalidateQueries({ queryKey: ["notes", "relay"] })
      toast.success(value ? "Notes will sync through this relay" : "Notes sync is off", { duration: 2500 })
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (!problem) void save({ url: url.trim(), token: token.trim() })
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
      <p className="flex gap-2 text-xs text-muted-foreground">
        <Icon name="info" className="mt-0.5 size-4" />
        The relay can read your notes: they're encrypted on the way, not end to end.
      </p>

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
