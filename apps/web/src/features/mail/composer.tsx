import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { getCoreClient } from "@/core/client"
import { useAccounts, useCore } from "@/core/queries"
import type { Draft } from "@/core/types"
import { useIsTabletUp } from "@/hooks/use-media-query"

import { UNDO_SECONDS, formatRecipients, parseRecipients } from "./format"

/** Mounted once at the app root; opens whenever `useUi().composer` is set. */
export function Composer() {
  const draft = useUi((s) => s.composer)
  const close = useUi((s) => s.closeComposer)
  const tabletUp = useIsTabletUp()
  const open = draft !== null

  const body = open ? <ComposerForm key={JSON.stringify(draft)} initial={draft} onDone={close} /> : null

  if (tabletUp) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-2xl" showCloseButton={false}>
          <DialogTitle className="sr-only">New message</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      {/* Full-screen on phones, like Apple Mail and Gmail. */}
      <SheetContent side="bottom" className="gap-0 rounded-none border-0 pt-[env(safe-area-inset-top)] data-[side=bottom]:h-dvh" showCloseButton={false}>
        <SheetTitle className="sr-only">New message</SheetTitle>
        {body}
      </SheetContent>
    </Sheet>
  )
}

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-11 items-center gap-2 border-b px-4">
      <label htmlFor={htmlFor} className="w-14 shrink-0 text-sm text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}

const bare = "h-10 flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"

function ComposerForm({ initial, onDone }: { initial: Partial<Draft>; onDone: () => void }) {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const openComposer = useUi((s) => s.openComposer)
  const [chosenAccount, setAccountId] = useState(initial.accountId ?? "")
  // Default to the first account without an effect (accounts may load after open).
  const accountId = chosenAccount || accounts[0]?.id || ""
  const [to, setTo] = useState(formatRecipients(initial.to))
  const [cc, setCc] = useState(formatRecipients(initial.cc))
  const [showCc, setShowCc] = useState((initial.cc?.length ?? 0) > 0)
  const [subject, setSubject] = useState(initial.subject ?? "")
  const [body, setBody] = useState(initial.body ?? "")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const send = async () => {
    setError(null)
    setSending(true)
    const draft: Draft = {
      accountId,
      to: parseRecipients(to),
      cc: showCc ? parseRecipients(cc) : [],
      subject: subject.trim(),
      body,
      inReplyTo: initial.inReplyTo ?? null,
    }
    try {
      const client = await getCoreClient()
      const item = await client.queueSend(draft, UNDO_SECONDS)
      onDone()
      toast("Sending…", {
        id: item.id,
        duration: UNDO_SECONDS * 1000,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              openComposer(await client.cancelSend(item.id))
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          },
        },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSending(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => (e.preventDefault(), void send())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void send()
        }
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <h2 className="flex-1 truncate text-center text-sm font-semibold">{subject.trim() || "New message"}</h2>
        <Button type="submit" disabled={sending || accounts.length === 0} aria-keyshortcuts="Control+Enter Meta+Enter">
          <Icon name="send" data-icon="inline-start" /> Send
        </Button>
      </header>

      {accounts.length > 1 && (
        <Row label="From" htmlFor="composer-from">
          <NativeSelect id="composer-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="border-0 shadow-none">
            {accounts.map((a) => (
              <NativeSelectOption key={a.id} value={a.id}>
                {a.displayName} · {a.address}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Row>
      )}
      <Row label="To" htmlFor="composer-to">
        <input id="composer-to" className={bare} value={to} onChange={(e) => setTo(e.target.value)} autoFocus={!initial.to?.length} inputMode="email" autoComplete="email" />
        {!showCc && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowCc(true)}>
            Cc
          </Button>
        )}
      </Row>
      {showCc && (
        <Row label="Cc" htmlFor="composer-cc">
          <input id="composer-cc" className={bare} value={cc} onChange={(e) => setCc(e.target.value)} inputMode="email" />
        </Row>
      )}
      <Row label="Subject" htmlFor="composer-subject">
        <input id="composer-subject" className={bare} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Row>

      {error && (
        <p role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <Icon name="error" className="size-4" /> {error}
        </p>
      )}

      <textarea
        aria-label="Message"
        className="min-h-48 flex-1 resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus={!!initial.to?.length}
        onFocus={(e) => initial.inReplyTo && e.currentTarget.setSelectionRange(0, 0)}
      />
      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground">
        <Icon name="undo" className="size-4" />
        You can undo for {UNDO_SECONDS} seconds after sending.
        {core?.kind === "demo" && <span className="ml-auto">Sample mode — nothing really leaves.</span>}
      </footer>
    </form>
  )
}

/**
 * Reports outcomes once a send leaves the undo window. Mounted at the root.
 * The core emits `outbox:changed` with the item id when a send finishes.
 */
export function OutboxWatcher() {
  const { data: core } = useCore()
  const openComposer = useUi((s) => s.openComposer)
  useEffect(() => {
    if (!core) return
    return core.on("outbox:changed", async (id) => {
      if (typeof id !== "string") return
      const failed = (await core.listOutbox()).find((i) => i.id === id && i.state === "failed")
      if (failed) {
        toast.dismiss(id)
        toast.error(`Couldn't send “${failed.draft.subject || "(no subject)"}”`, {
          description: failed.error ?? undefined,
          duration: Infinity,
          action: { label: "Edit", onClick: () => openComposer(failed.draft) },
        })
      } else {
        // Replace the "Sending…" toast outright: reusing its id would keep its Undo action.
        toast.dismiss(id)
        toast.success("Sent", { duration: 2500 })
      }
    })
  }, [core, openComposer])
  return null
}
