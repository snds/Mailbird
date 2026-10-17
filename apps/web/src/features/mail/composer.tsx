import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { useUi, type ComposerDraft } from "@/app/ui-store"
import { Icon, Button, ButtonGroup, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Field, FieldLabel, Input, NativeSelect, NativeSelectOption, Sheet, SheetContent, SheetTitle, DialogAction, DialogActions } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useAccounts, useCore, useLocalTimes, useMailPrefs, useSignatures, useTemplates } from "@/core/queries"
import type { Draft, LocalTime, OutgoingAttachment, Template } from "@/core/types"
import { useIsTabletUp } from "@/hooks/use-media-query"
import { useNowSecs } from "@/hooks/use-now"
import { FOLLOW_UP_OPTIONS, longTime, nextLocalHour, partOfDay, timeThere, utcLabel } from "@/lib/time"

import { UNDO_SECONDS, formatRecipients, formatSize, parseRecipients } from "./format"
import { RecipientInput } from "./recipient-input"
import { FormatBar, RichEditor } from "./rich-editor"
import { FollowUpAfterMenu, SendLaterMenu, type TheirMorning } from "./send-later"
import { signatureBlock, withSignature } from "./signature"
import { useRichEditor } from "./use-rich-editor"
import { htmlToText, textToHtml } from "./rich-text"

/** Most providers reject messages over 25 MB; base64 adds about a third. */
const MAX_ATTACHMENTS = 25 * 1024 * 1024

const bytesOf = (a: OutgoingAttachment) => Math.floor((a.dataBase64.length * 3) / 4)

function readFile(file: File): Promise<OutgoingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`couldn't read ${file.name}`))
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ filename: file.name, mimeType: file.type || "application/octet-stream", dataBase64: url.slice(url.indexOf(",") + 1) })
    }
    reader.readAsDataURL(file)
  })
}

const firstName = (t: LocalTime) => t.name?.trim().split(/\s+/)[0] || t.email

/** "Night there", "Weekend there", …, or null in their working hours. */
const dayThere = (t: LocalTime, now: number) => {
  const there = new Date((now + t.offset * 60) * 1000)
  return partOfDay(there.getUTCHours(), there.getUTCDay())
}

/** 9:00 AM on each recipient's next workday, for those in another zone than
 * yours: one per offset, at most two, so the menu stays short (ADR-0041). */
function theirMornings(times: LocalTime[], now: number): (TheirMorning & { offset: number })[] {
  const mine = -new Date(now * 1000).getTimezoneOffset()
  const seen = new Set<number>()
  const out: (TheirMorning & { offset: number })[] = []
  for (const t of times) {
    if (t.offset === mine || seen.has(t.offset) || out.length === 2) continue
    seen.add(t.offset)
    const at = nextLocalHour(t.offset, now)
    out.push({
      offset: t.offset,
      at,
      label: `${timeThere(t.offset, at)} for ${firstName(t)}`,
      detail: new Date(at * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }),
    })
  }
  return out
}

/** Mounted once at the app root; opens whenever `useUi().composer` is set. */
/** The form marks its first field (To, or the body for replies); the dialog focuses it once open. */
const firstField = () => document.querySelector<HTMLElement>("[data-composer-focus]") ?? true
/** Undo can reopen the composer while its close is still finishing; don't hand focus back to the page then. */
const returnFocus = () => useUi.getState().composer === null

export function Composer() {
  const draft = useUi((s) => s.composer)
  const close = useUi((s) => s.closeComposer)
  const tabletUp = useIsTabletUp()
  const open = draft !== null
  // Loaded while closed, so a new message opens with its signature in place.
  useSignatures()
  useTemplates()

  const body = open ? <ComposerForm key={JSON.stringify(draft)} initial={draft} onDone={close} /> : null

  if (tabletUp) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-2xl" showCloseButton={false} initialFocus={firstField} finalFocus={returnFocus}>
          <DialogTitle className="sr-only">New message</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      {/* Full-screen on phones, like Apple Mail and Gmail. */}
      {/* Above the keyboard on iOS too, which covers the page instead of resizing it. */}
      <SheetContent
        side="bottom"
        fullscreen
        className="data-[side=bottom]:bottom-(--keyboard-inset) data-[side=bottom]:h-[calc(100dvh-var(--keyboard-inset))]"
        showCloseButton={false}
        initialFocus={firstField}
        finalFocus={returnFocus}
      >
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

function ComposerForm({ initial, onDone }: { initial: ComposerDraft; onDone: () => void }) {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const { data: signatures } = useSignatures()
  const { data: templates = [] } = useTemplates()
  const openComposer = useUi((s) => s.openComposer)
  const setWritingOpen = useUi((s) => s.setWritingOpen)
  const [chosenAccount, setAccountId] = useState(initial.accountId ?? "")
  // Default to the first account without an effect (accounts may load after open).
  const accountId = chosenAccount || accounts[0]?.id || ""
  const [to, setTo] = useState(formatRecipients(initial.to))
  const [cc, setCc] = useState(formatRecipients(initial.cc))
  const [showCc, setShowCc] = useState((initial.cc?.length ?? 0) > 0)
  const [subject, setSubject] = useState(initial.subject ?? "")
  const [sendAt, setSendAt] = useState<number | null>(initial.sendAt ?? null)
  const [followUp, setFollowUp] = useState<number | null>(initial.followUpAfter ?? null)
  // A read receipt (ADR-0055): Advanced settings' default, until changed here.
  const { data: mailPrefs } = useMailPrefs()
  const [receiptChoice, setReceipt] = useState<boolean | null>(initial.requestReceipt ?? null)
  const receipt = receiptChoice ?? mailPrefs?.requestReceipts ?? false
  // Their clocks (ADR-0041): who in To lives somewhere else, from their own mail.
  const toEmails = useDeferredValue(useMemo(() => parseRecipients(to).map((a) => a.email.toLowerCase()).slice(0, 10), [to]))
  const { data: localTimes = [] } = useLocalTimes(toEmails)
  const now = useNowSecs(30_000)
  const theirs = useMemo(() => theirMornings(localTimes, now), [localTimes, now])
  const late = localTimes.map((t) => ({ t, day: dayThere(t, now) })).find((x) => x.day)
  const [savingTemplate, setSavingTemplate] = useState(false)
  // Each account's signature, as the editor renders it.
  const blocks = useMemo(() => new Map((signatures ?? []).map((s) => [s.accountId, signatureBlock(s.html)])), [signatures])
  const baseHtml = initial.bodyHtml ?? textToHtml(initial.body ?? "")
  const firstBlock = blocks.get(initial.accountId || accounts[0]?.id || "") ?? ""
  const editor = useRichEditor({
    html: signatures ? withSignature(baseHtml, firstBlock) : baseHtml,
    placeholder: "Write your message",
    // Replies (and reopened drafts) start in the body, above any quote; new mail and forwards start in To.
    focusFirst: !!initial.to?.length,
  })
  // The signature now in the body (null until signatures have loaded).
  const shownBlock = useRef<string | null>(signatures ? [...blocks.values()].find((b) => b && editor.getHTML().includes(b)) ?? "" : null)
  // Signatures that load late are added once; changing From swaps the signature.
  useEffect(() => {
    if (!signatures) return
    const next = blocks.get(accountId) ?? ""
    const html = editor.getHTML()
    const keepCursor = () => editor.isFocused && editor.commands.setTextSelection(1)
    if (shownBlock.current === null) {
      const present = [...blocks.values()].find((b) => b && html.includes(b))
      shownBlock.current = present ?? ""
      if (present) return
      const signed = withSignature(html, next)
      if (signed !== html) {
        editor.commands.setContent(signed, { emitUpdate: false })
        keepCursor()
        shownBlock.current = next
      }
      return
    }
    if (next === shownBlock.current || !shownBlock.current || !html.includes(shownBlock.current)) return
    editor.commands.setContent(html.replace(shownBlock.current, next), { emitUpdate: false })
    shownBlock.current = next
  }, [signatures, blocks, accountId, editor])

  const insertTemplate = (t: Template) => {
    editor.chain().focus().insertContent(t.html).run()
    if (!subject.trim() && t.subject) setSubject(t.subject)
  }
  const [files, setFiles] = useState<OutgoingAttachment[]>(initial.attachments ?? [])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  // Opened from a toast action (Undo, Edit), the composer races Sonner, which
  // hands focus back to whatever had it before the toast as the toast goes
  // away. The dialog is modal, so for its first second any focus landing
  // outside it is that hand-back: take it back.
  useEffect(() => {
    const first = () => formRef.current?.closest("[role=dialog]")?.querySelector<HTMLElement>("[data-composer-focus]")
    // Focus on the dialog's own container (its fallback when the field wasn't
    // in the DOM yet) or outside it is a miss: move it to the first field.
    const missed = (el: Element | null) => {
      const dialog = formRef.current?.closest("[role=dialog]")
      // Menus and dialogs the composer opens (send later, templates) sit outside it too, on purpose.
      return !!dialog && (!el || el === dialog || el === document.body || (!dialog.contains(el) && !el.closest("[data-sonner-toaster], [role=menu], [role=dialog]")))
    }
    const onFocusIn = (e: FocusEvent) => {
      if (missed(e.target instanceof Element ? e.target : null)) first()?.focus()
    }
    document.addEventListener("focusin", onFocusIn)
    // The editor mounts its DOM after the dialog opens; check once it has.
    // A reply written below the quote starts there (ADR-0055).
    const afterQuote = () => {
      if (!initial.cursorAfterQuote) return
      let pos = -1
      let seenQuote = false
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === "blockquote") seenQuote = true
        else if (seenQuote && pos < 0 && node.type.name === "paragraph" && node.content.size === 0) pos = offset + 1
      })
      if (pos > 0) editor.commands.setTextSelection(pos)
    }
    const frame = requestAnimationFrame(() => {
      if (missed(document.activeElement)) first()?.focus()
      afterQuote()
    })
    const stop = setTimeout(() => document.removeEventListener("focusin", onFocusIn), 1000)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(stop)
      document.removeEventListener("focusin", onFocusIn)
    }
    // Once, when the composer opens: the editor and its first draft are fixed by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const totalBytes = files.reduce((n, f) => n + bytesOf(f), 0)

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    try {
      const read = await Promise.all([...list].map(readFile))
      setFiles((prev) => [...prev, ...read])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const send = async () => {
    setError(null)
    setSending(true)
    const html = editor.isEmpty ? null : editor.getHTML()
    const draft: Draft = {
      accountId,
      to: parseRecipients(to),
      cc: showCc ? parseRecipients(cc) : [],
      subject: subject.trim(),
      body: html ? htmlToText(html) : "",
      bodyHtml: html,
      inReplyTo: initial.inReplyTo ?? null,
      references: initial.references ?? [],
      attachments: files,
      followUpAfter: followUp,
      requestReceipt: receipt,
    }
    try {
      const client = await getCoreClient()
      const item = await client.queueSend(draft, UNDO_SECONDS, sendAt)
      onDone()
      if (sendAt !== null) {
        toast.success(`Scheduled for ${longTime(item.sendAt)}`, {
          description: followUp ? `If nobody replies, it comes back ${FOLLOW_UP_OPTIONS.find((o) => o.after === followUp)?.label ?? ""} after it goes out.` : undefined,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                openComposer({ ...(await client.cancelSend(item.id)), sendAt: item.sendAt })
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e))
              }
            },
          },
        })
        return
      }
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
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => (e.preventDefault(), void send())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void send()
        }
      }}
      // Drop files anywhere on the composer to attach them.
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <h2 className="flex-1 truncate text-center text-sm font-semibold">{subject.trim() || "New message"}</h2>
        <ButtonGroup>
          <Button type="submit" disabled={sending || accounts.length === 0 || totalBytes > MAX_ATTACHMENTS} aria-keyshortcuts="Control+Enter Meta+Enter">
            <Icon name={sendAt === null ? "send" : "schedule_send"} data-icon="inline-start" /> {sendAt === null ? "Send" : "Schedule"}
          </Button>
          <SendLaterMenu onPick={setSendAt} theirs={theirs} trigger={<Button type="button" size="icon" aria-label="Send later" disabled={sending || accounts.length === 0} />}>
            <Icon name="keyboard_arrow_down" />
          </SendLaterMenu>
        </ButtonGroup>
      </header>
      {sendAt !== null && (
        <p className="flex items-center gap-2 border-b bg-accent/50 px-4 py-2 text-sm">
          <Icon name="schedule_send" tone="muted" className="size-4" />
          <span className="flex-1">Sends {longTime(sendAt)}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSendAt(null)}>
            Send now instead
          </Button>
        </p>
      )}

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
        <RecipientInput id="composer-to" className={bare} value={to} onChange={setTo} data-composer-focus={initial.to?.length ? undefined : ""} inputMode="email" />
        {!showCc && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowCc(true)}>
            Cc
          </Button>
        )}
      </Row>
      {showCc && (
        <Row label="Cc" htmlFor="composer-cc">
          <RecipientInput id="composer-cc" className={bare} value={cc} onChange={setCc} inputMode="email" />
        </Row>
      )}
      {late && (
        // Outside their working hours: say so, and offer their morning (ADR-0041).
        <p data-slot="recipient-local-time" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-4 py-2 text-sm">
          <Icon name={late.day === "Night there" ? "bedtime" : "schedule"} tone="muted" className="size-4" />
          {/* On phones the sentence gets the line and the offer drops under it, aligned with the text. */}
          <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-1.5rem)]">
            It's {timeThere(late.t.offset, now)} for {firstName(late.t)} <span className="text-muted-foreground">· {late.day} · {utcLabel(late.t.offset)}</span>
          </span>
          {sendAt === null && theirs[0] && theirs[0].offset === late.t.offset && (
            <Button type="button" variant="outline" size="sm" className="max-sm:ml-6" onClick={() => setSendAt(theirs[0]!.at)}>
              <Icon name="schedule_send" data-icon="inline-start" /> Send {theirs[0].label}
            </Button>
          )}
        </p>
      )}
      <Row label="Subject" htmlFor="composer-subject">
        <input id="composer-subject" className={bare} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Row>

      {error && (
        <p role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <Icon name="error" className="size-4" /> {error}
        </p>
      )}

      <RichEditor editor={editor} />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t px-4 py-2" aria-label="Attachments">
          {files.map((f, i) => (
            <li key={`${f.filename}-${i}`} className="flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/40 py-1 pr-1 pl-2 text-xs">
              <Icon name="attach_file" tone="muted" className="size-4" />
              <span className="max-w-48 truncate font-medium">{f.filename}</span>
              <span className="text-muted-foreground">{formatSize(bytesOf(f))}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${f.filename}`} onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                <Icon name="close" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormatBar editor={editor} />
      <footer className="flex shrink-0 items-center gap-2 border-t px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground">
        <input ref={picker} type="file" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ""))} />
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files" onClick={() => picker.current?.click()}>
          <Icon name="attach_file" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="Templates" />}>
            <Icon name="article" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {templates.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Insert a template</DropdownMenuLabel>
                {templates.map((t) => (
                  <DropdownMenuItem key={t.id} onClick={() => insertTemplate(t)}>
                    <Icon name="article" />
                    <span className="truncate">{t.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
            {templates.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => setSavingTemplate(true)} disabled={editor.isEmpty}>
              <Icon name="save" />
              Save as template…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setWritingOpen(true)}>
              <Icon name="edit_note" />
              Signatures and templates…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={receipt} onCheckedChange={(on) => setReceipt(on)}>
              <Icon name="mark_email_read" />
              Ask for a read receipt
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <FollowUpAfterMenu
          value={followUp}
          onChange={setFollowUp}
          trigger={<Button type="button" variant={followUp ? "secondary" : "ghost"} size={followUp ? "sm" : "icon"} aria-label="Remind me if no reply" />}
        >
          <Icon name={followUp ? "notifications_active" : "notifications"} data-icon={followUp ? "inline-start" : undefined} />
          {followUp ? `Remind in ${FOLLOW_UP_OPTIONS.find((o) => o.after === followUp)?.label ?? "a while"}` : null}
        </FollowUpAfterMenu>
        {totalBytes > MAX_ATTACHMENTS ? (
          <span className="text-destructive">Attachments total {formatSize(totalBytes)} — over the 25 MB most servers accept.</span>
        ) : sendAt !== null ? (
          <span className="hidden sm:inline">Until then, change or cancel it in Scheduled.</span>
        ) : (
          <span className="hidden items-center gap-1 sm:flex">
            <Icon name="undo" className="size-4" />
            You can undo for {UNDO_SECONDS} seconds after sending.
          </span>
        )}
        {core?.kind === "demo" && <span className="ml-auto">Sample mode — nothing really leaves.</span>}
      </footer>
      <SaveTemplateDialog
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        subject={subject.trim()}
        // A template is the message itself, without the signature.
        html={() => (shownBlock.current ? editor.getHTML().replace(shownBlock.current, "") : editor.getHTML())}
      />
    </form>
  )
}

function SaveTemplateDialog({ open, onOpenChange, subject, html }: { open: boolean; onOpenChange: (open: boolean) => void; subject: string; html: () => string }) {
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), setError(null))}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          // Inside the composer's form (React events cross portals): keep this from sending the message.
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={async (e) => {
            e.preventDefault()
            e.stopPropagation()
            try {
              await (await getCoreClient()).saveTemplate({ name, subject, html: html() })
              onOpenChange(false)
              setName("")
              toast.success(`Saved “${name.trim()}”`)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>Insert it into any message later, from the templates button.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="template-name">Name</FieldLabel>
            <Input id="template-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting follow-up" />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogActions>
            <DialogAction kind="cancel" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </DialogAction>
            <DialogAction type="submit" disabled={!name.trim()}>
              Save template
            </DialogAction>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
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
