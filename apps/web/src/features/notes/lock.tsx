import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useNotesLock } from "@/core/queries"
import type { NotesLockInfo } from "@/core/types"

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"

/** After a lock change, every view of notes reads again (the key lives in the core). */
function useRefreshNotes() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: ["notes"] })
}

/**
 * The passphrase step before locking (ADR-0043): set one the first time,
 * or unlock with it when notes are locked. Resolves `onDone` once the key
 * is in memory.
 */
export function PassphraseDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { data: info } = useNotesLock()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {open && info && (info.set ? <UnlockForm info={info} onDone={onDone} onCancel={() => onOpenChange(false)} /> : <SetForm onDone={onDone} onCancel={() => onOpenChange(false)} />)}
      </DialogContent>
    </Dialog>
  )
}

function SetForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [pass, setPass] = useState("")
  const [again, setAgain] = useState("")
  const [hint, setHint] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useRefreshNotes()
  const mismatch = again.length > 0 && pass !== again
  const submit = async () => {
    if (pass !== again) return setError("The two passphrases don't match.")
    setBusy(true)
    try {
      await (await getCoreClient()).setNotesPassphrase(pass, hint.trim() || null)
      refresh()
      onDone()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>Set a passphrase for locked notes</DialogTitle>
        <DialogDescription>One passphrase opens every locked note, on all your devices.</DialogDescription>
      </DialogHeader>
      <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>If you forget it, your locked notes can't be opened. Nobody can reset it, Mailbird included.</span>
      </p>
      {/* Labels stay short; help and errors are descriptions, so a field's name is just its name. */}
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="lock-pass">Passphrase</label>
        <input
          id="lock-pass"
          type="password"
          autoComplete="new-password"
          className={field}
          value={pass}
          onChange={(e) => (setPass(e.target.value), setError(null))}
          aria-describedby="lock-pass-help"
          autoFocus
        />
        <span id="lock-pass-help" className="text-xs text-muted-foreground">
          At least 6 characters. A short sentence is easy to remember and hard to guess.
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="lock-again">Again</label>
        <input
          id="lock-again"
          type="password"
          autoComplete="new-password"
          className={field}
          value={again}
          onChange={(e) => (setAgain(e.target.value), setError(null))}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? "lock-again-error" : undefined}
        />
        {mismatch && (
          <span id="lock-again-error" className="text-xs text-destructive">
            Doesn't match yet.
          </span>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Hint (optional)
        <input id="lock-hint" className={field} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Something only you would know" />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !pass || !again}>
          Set passphrase
        </Button>
      </DialogFooter>
    </form>
  )
}

function UnlockForm({ info, onDone, onCancel }: { info: NotesLockInfo; onDone: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Unlock notes</DialogTitle>
        <DialogDescription>Enter your passphrase for locked notes.</DialogDescription>
      </DialogHeader>
      <UnlockFields info={info} onDone={onDone} onCancel={onCancel} />
    </div>
  )
}

/** The passphrase field, Unlock, and the hint on request. Shared by the dialog and a locked note. */
function UnlockFields({ info, onDone, onCancel }: { info: NotesLockInfo; onDone?: () => void; onCancel?: () => void }) {
  const [pass, setPass] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useRefreshNotes()
  const submit = async () => {
    setBusy(true)
    try {
      await (await getCoreClient()).unlockNotes(pass)
      refresh()
      onDone?.()
    } catch (e) {
      setError(message(e))
      setPass("")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex w-full flex-col gap-3" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="sr-only">Passphrase</span>
        <input
          id="unlock-pass"
          type="password"
          autoComplete="current-password"
          className={field}
          placeholder="Passphrase"
          aria-label="Passphrase"
          value={pass}
          onChange={(e) => (setPass(e.target.value), setError(null))}
          aria-invalid={!!error || undefined}
          autoFocus
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.charAt(0).toUpperCase() + error.slice(1)}.
        </p>
      )}
      {hint && info.hint && <p className="text-sm text-muted-foreground">Hint: {info.hint}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {info.hint && !hint && (
          <Button type="button" variant="ghost" size="sm" className="mr-auto text-muted-foreground" onClick={() => setHint(true)}>
            Show hint
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="outline" className={info.hint && !hint ? undefined : "ml-auto"} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy || !pass} className={!onCancel && (!info.hint || hint) ? "ml-auto" : undefined}>
          <Icon name="lock_open" data-icon="inline-start" /> Unlock
        </Button>
      </div>
    </form>
  )
}

/** What a locked note shows while notes are locked: its title and a way in. */
export function LockedPanel({ title }: { title: string }) {
  const { data: info } = useNotesLock()
  return (
    <section aria-label="Locked note" className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center gap-4 px-6 py-12 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-muted">
        <Icon name="lock" className="size-7 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-balance">{title || "Locked note"}</h2>
        <p className="text-sm text-muted-foreground">This note is locked. Its text is sealed on this device and in sync.</p>
      </div>
      {info && <UnlockFields info={info} />}
    </section>
  )
}
