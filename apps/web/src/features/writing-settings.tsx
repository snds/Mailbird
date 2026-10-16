import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Field, FieldLabel, Input } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useAccounts, useSignatures, useTemplates } from "@/core/queries"
import type { Account, Template } from "@/core/types"
import { FormatBar, RichEditor } from "@/features/mail/rich-editor"
import { htmlToText } from "@/features/mail/rich-text"
import { useRichEditor } from "@/features/mail/use-rich-editor"

/**
 * Signatures (one per account, added to new messages and replies) and
 * templates (inserted from the composer). Both live in the core (ADR-0017).
 */
export function WritingDialog() {
  const open = useUi((s) => s.writingOpen)
  const setOpen = useUi((s) => s.setWritingOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Signatures and templates</DialogTitle>
          <DialogDescription>Signatures go on new messages and replies. Templates are text you reuse, inserted from the composer.</DialogDescription>
        </DialogHeader>
        {open && <WritingSettings />}
      </DialogContent>
    </Dialog>
  )
}

function WritingSettings() {
  const { data: accounts = [] } = useAccounts()
  const { data: signatures } = useSignatures()
  const { data: templates = [] } = useTemplates()
  const [editing, setEditing] = useState<Template | "new" | null>(null)
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="signatures-heading">
        <h3 id="signatures-heading" className="text-sm font-medium">
          Signatures
        </h3>
        {accounts.length === 0 && <p className="text-sm text-muted-foreground">Add an account first.</p>}
        {signatures &&
          accounts.map((a) => <SignatureEditor key={a.id} account={a} html={signatures.find((s) => s.accountId === a.id)?.html ?? ""} />)}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="templates-heading">
        <div className="flex items-center justify-between">
          <h3 id="templates-heading" className="text-sm font-medium">
            Templates
          </h3>
          {editing === null && (
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Icon name="add" data-icon="inline-start" /> New template
            </Button>
          )}
        </div>
        {editing !== null && <TemplateEditor key={editing === "new" ? "new" : editing.id} template={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
        {templates.length === 0 && editing === null ? (
          <p className="text-sm text-muted-foreground">No templates yet. Write one here, or use “Save as template” in the composer.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border" aria-label="Templates">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <Icon name="article" tone="muted" className="size-5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{t.subject || htmlToText(t.html).slice(0, 80)}</span>
                </span>
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                  <Icon name="edit" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${t.name}`}
                  onClick={async () => {
                    const client = await getCoreClient()
                    await client.deleteTemplate(t.id)
                    toast(`Deleted “${t.name}”`, {
                      action: { label: "Undo", onClick: () => void client.saveTemplate({ name: t.name, subject: t.subject, html: t.html }) },
                    })
                  }}
                >
                  <Icon name="delete" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function SignatureEditor({ account, html }: { account: Account; html: string }) {
  const editor = useRichEditor({ html, placeholder: "No signature", focusFirst: false, label: `Signature for ${account.address}`, compact: true })
  const [saving, setSaving] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        {account.displayName} · {account.address}
      </span>
      <div className="flex flex-col rounded-xl border">
        <RichEditor editor={editor} />
        <div className="flex items-center justify-between gap-2 border-t pr-2">
          <FormatBar editor={editor} />
          <Button
            size="sm"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              try {
                await (await getCoreClient()).setSignature(account.id, editor.isEmpty ? "" : editor.getHTML())
                toast.success(editor.isEmpty ? `Removed the signature for ${account.address}` : `Saved the signature for ${account.address}`)
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e))
              } finally {
                setSaving(false)
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function TemplateEditor({ template, onDone }: { template: Template | null; onDone: () => void }) {
  const [name, setName] = useState(template?.name ?? "")
  const [subject, setSubject] = useState(template?.subject ?? "")
  const [error, setError] = useState<string | null>(null)
  const editor = useRichEditor({ html: template?.html ?? "", placeholder: "Write the template", focusFirst: false, label: "Template text", compact: true })
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await (await getCoreClient()).saveTemplate({ id: template?.id ?? null, name, subject, html: editor.getHTML() })
          onDone()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="tpl-name">Name</FieldLabel>
          <Input id="tpl-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting follow-up" autoFocus />
        </Field>
        <Field>
          <FieldLabel htmlFor="tpl-subject">Subject (optional)</FieldLabel>
          <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Fills an empty subject" />
        </Field>
      </div>
      <div className="flex flex-col rounded-lg border bg-background">
        <RichEditor editor={editor} />
        <FormatBar editor={editor} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim()}>
          {template ? "Save changes" : "Save template"}
        </Button>
      </div>
    </form>
  )
}
