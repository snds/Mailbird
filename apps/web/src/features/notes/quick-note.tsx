import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { type QuickContext, useUi } from "@/app/ui-store"
import { Icon, type IconName, Button, Kbd, AdaptiveSheetContent, Sheet, SheetDescription, SheetTitle, IconButton } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useLinkedNotes } from "@/core/queries"

const ICON: Record<QuickContext["kind"], IconName> = { event: "event", contact: "person", thread: "mail" }

/**
 * Quick Note (Apple Notes): jot something down without leaving what you're
 * doing, already linked to it (ADR-0037). Opens with ⌥N or ⌘K anywhere, or
 * from any Notes section. Closing saves; an empty note is just dropped.
 */
export function QuickNote() {
  const state = useUi((s) => s.quickNote)
  const close = useUi((s) => s.closeQuickNote)
  // Mounted while open, so each opening starts fresh.
  const [draft, setDraft] = useState<{ text: string; linked: boolean } | null>(null)
  const save = useSaveQuickNote()

  const onOpenChange = (open: boolean) => {
    if (open) return
    if (draft?.text.trim()) void save(draft.text, draft.linked ? (state?.target ?? null) : null)
    setDraft(null)
    close()
  }

  // ⌥N, from anywhere but a text field (where it may be typing a character).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyN" || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, [contenteditable=true]")) return
      e.preventDefault()
      if (!useUi.getState().quickNote) useUi.getState().openQuickNote()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <Sheet open={!!state} onOpenChange={onOpenChange}>
      <AdaptiveSheetContent className="flex flex-col gap-3 px-5 pb-5 sm:pt-5">
        {state && <Composer target={state.target} onChange={setDraft} onDone={() => onOpenChange(false)} />}
      </AdaptiveSheetContent>
    </Sheet>
  )
}

function Composer({ target, onChange, onDone }: { target: QuickContext | null; onChange: (d: { text: string; linked: boolean }) => void; onDone: () => void }) {
  const [text, setText] = useState("")
  const [linked, setLinked] = useState(!!target)
  const ref = useRef<HTMLTextAreaElement>(null)
  const { data: here = [] } = useLinkedNotes(target ? { kind: target.kind, id: target.id } : null)
  // The name the saved link will carry (a conversation's first subject, say), so the chip matches it.
  const { data: link } = useQuery({
    queryKey: ["notes", "link", target?.kind, target?.id],
    queryFn: async () => (await getCoreClient()).noteLinkFor({ kind: target!.kind, id: target!.id }),
    enabled: !!target,
  })
  const label = link?.label || target?.label || "This item"
  const jumpTo = useUi((s) => s.jumpTo)
  const close = useUi((s) => s.closeQuickNote)
  const update = (t: string, l: boolean) => {
    setText(t)
    setLinked(l)
    onChange({ text: t, linked: l })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 pr-10 max-sm:pr-0">
        <SheetTitle>Quick note</SheetTitle>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <Kbd>⌥N</Kbd> anywhere
        </span>
      </div>
      <SheetDescription className="sr-only">A note saved to Notes when you close this.</SheetDescription>
      {target && linked && (
        <div className="flex">
          <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border bg-muted/50 pr-0.5 pl-2.5 text-xs" data-slot="quick-link">
            <Icon name={ICON[target.kind]} className="size-3.5" />
            <span className="truncate">{label}</span>
            <IconButton label={`Don't link to ${label}`} icon="close" render={<Button variant="ghost-muted" size="icon-xs" shape="pill" />} onClick={() => update(text, false)} />
          </span>
        </div>
      )}
      <textarea
        ref={ref}
        autoFocus
        aria-label="Quick note"
        placeholder={"The first line is the title.\nIt saves when you close this."}
        className="min-h-40 w-full flex-1 resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
        value={text}
        onChange={(e) => update(e.target.value, linked)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onDone()
          }
        }}
      />
      {target && linked && here.length > 0 && (
        <section aria-label="Notes here already" className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Already noted here</span>
          <div className="flex flex-wrap gap-1.5">
            {here.slice(0, 3).map((n) => (
              <Button
                key={n.id}
                size="xs"
                variant="outline"
                shape="pill"
                onClick={() => {
                  close()
                  jumpTo({ kind: "note", id: n.id })
                }}
              >
                {n.title || "New note"}
              </Button>
            ))}
          </div>
        </section>
      )}
      {/* Phones: a pill level with the floating close button, both in the thumb zone. */}
      <div className="flex justify-end max-sm:absolute max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:left-4">
        <Button size="sm" className="max-sm:h-10 max-sm:rounded-full max-sm:px-5 max-sm:shadow-md" disabled={!text.trim()} onClick={onDone}>
          Save note
        </Button>
      </div>
    </>
  )
}

function useSaveQuickNote() {
  const qc = useQueryClient()
  const jumpTo = useUi((s) => s.jumpTo)
  return async (text: string, target: QuickContext | null) => {
    try {
      const core = await getCoreClient()
      const link = target ? await core.noteLinkFor({ kind: target.kind, id: target.id }) : null
      const n = await core.createNote({ markdown: text.trim(), links: link ? [link] : [] })
      await qc.invalidateQueries({ queryKey: ["notes"] })
      toast.success(link ? `Saved to Notes, linked to ${link.label}` : "Saved to Notes", {
        duration: 4000,
        action: { label: "Open", onClick: () => jumpTo({ kind: "note", id: n.id }) },
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
}
