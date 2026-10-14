import { useState } from "react"
import { toast } from "sonner"

import { useUi, type ContactEditorState } from "@/app/ui-store"
import { EditorFrame, EditorHeader } from "@/components/editor-frame"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useAccounts, useCollections, usePimAction } from "@/core/queries"
import type { ContactField, ContactInput } from "@/core/types"

const EMAIL_LABELS = ["home", "work", "other"]
const PHONE_LABELS = ["cell", "home", "work", "other"]

export function ContactEditor() {
  const state = useUi((s) => s.contactEditor)
  const close = useUi((s) => s.closeContactEditor)
  return (
    <EditorFrame open={state !== null} onClose={close} title={state?.contactId ? "Edit contact" : "New contact"}>
      {state && <ContactForm key={JSON.stringify(state)} state={state} onDone={close} />}
    </EditorFrame>
  )
}

const bare = "h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"

/** A repeatable label + value list (emails, phone numbers). */
function FieldList({ kind, values, onChange, labels }: { kind: "email" | "phone"; values: ContactField[]; onChange: (v: ContactField[]) => void; labels: string[] }) {
  const noun = kind === "email" ? "email" : "phone"
  const rows = values.length ? values : [{ label: labels[0]!, value: "" }]
  const set = (i: number, patch: Partial<ContactField>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="border-b" role="group" aria-label={kind === "email" ? "Emails" : "Phone numbers"}>
      {rows.map((f, i) => (
        <div key={i} className="flex items-center gap-2 px-4">
          <NativeSelect size="sm" value={f.label ?? ""} onChange={(e) => set(i, { label: e.target.value || null })} aria-label={`${noun} ${i + 1} label`} className="w-24 shrink-0">
            {[...new Set([...labels, ...(f.label ? [f.label] : [])])].map((l) => (
              <NativeSelectOption key={l} value={l}>
                {l}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <input
            className={bare}
            type={kind === "email" ? "email" : "tel"}
            inputMode={kind === "email" ? "email" : "tel"}
            placeholder={kind === "email" ? "Email" : "Phone"}
            aria-label={`${noun} ${i + 1}`}
            value={f.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          {rows.length > 1 && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Icon name="do_not_disturb_on" />
            </Button>
          )}
        </div>
      ))}
      <button type="button" className="flex h-10 w-full items-center gap-2 px-4 text-sm text-primary hover:bg-muted/50" onClick={() => onChange([...rows, { label: labels[0]!, value: "" }])}>
        <Icon name="add_circle" className="size-4" /> Add {noun}
      </button>
    </div>
  )
}

function ContactForm({ state, onDone }: { state: ContactEditorState; onDone: () => void }) {
  const { initial, contactId } = state
  const { data: books = [] } = useCollections("contacts")
  const { data: accounts = [] } = useAccounts()
  const writable = books.filter((b) => b.writable)
  const save = usePimAction((c, input: ContactInput) => (contactId ? c.updateContact(contactId, input) : c.createContact(input)))
  const [fullName, setFullName] = useState(initial.fullName ?? "")
  const [org, setOrg] = useState(initial.org ?? "")
  const [title, setTitle] = useState(initial.title ?? "")
  const [emails, setEmails] = useState<ContactField[]>(initial.emails ?? [])
  const [phones, setPhones] = useState<ContactField[]>(initial.phones ?? [])
  const [birthday, setBirthday] = useState(initial.birthday?.startsWith("--") ? "" : (initial.birthday ?? ""))
  const [note, setNote] = useState(initial.note ?? "")
  const [chosen, setBook] = useState(initial.bookId ?? "")
  const bookId = chosen || writable[0]?.id || ""
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!bookId) return setError("There's no address book you can write to.")
    const input: ContactInput = {
      bookId,
      fullName: fullName.trim(),
      org: org.trim() || null,
      title: title.trim() || null,
      emails: emails.filter((e) => e.value.trim()),
      phones: phones.filter((p) => p.value.trim()),
      // A yearless birthday from another app stays as it was unless replaced.
      birthday: birthday || (initial.birthday?.startsWith("--") ? initial.birthday : null),
      note: note.trim() || null,
    }
    try {
      await save.mutateAsync(input)
      toast.success(contactId ? "Contact updated" : "Contact added", { duration: 2000 })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const name = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.displayName ?? "Account" : "On this device")
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <EditorHeader
        title={contactId ? "Edit contact" : "New contact"}
        onCancel={onDone}
        action={
          <Button type="submit" disabled={save.isPending}>
            {contactId ? "Save" : "Add"}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b px-4 py-2">
          <input aria-label="Name" placeholder="Name" autoComplete="name" className="h-11 w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground" value={fullName} onChange={(e) => setFullName(e.target.value)} data-editor-focus="" />
          <input aria-label="Company" placeholder="Company" autoComplete="organization" className={`${bare} w-full`} value={org} onChange={(e) => setOrg(e.target.value)} />
          <input aria-label="Job title" placeholder="Job title" className={`${bare} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <FieldList kind="email" values={emails} onChange={setEmails} labels={EMAIL_LABELS} />
        <FieldList kind="phone" values={phones} onChange={setPhones} labels={PHONE_LABELS} />
        <label className="flex min-h-12 items-center gap-3 border-b px-4">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">Birthday</span>
          <input type="date" aria-label="Birthday" className="ml-auto h-9 rounded-lg border bg-transparent px-2 text-sm dark:bg-input/30" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </label>
        <div className="flex min-h-12 items-center gap-3 border-b px-4">
          <label htmlFor="contact-book" className="w-24 shrink-0 text-sm text-muted-foreground">
            Save to
          </label>
          <NativeSelect id="contact-book" value={bookId} onChange={(e) => setBook(e.target.value)} className="ml-auto max-w-[60%]">
            {writable.map((b) => (
              <NativeSelectOption key={b.id} value={b.id}>
                {b.accountId && name(b.accountId) !== b.name ? `${name(b.accountId)} · ${b.name}` : b.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <textarea aria-label="Note" placeholder="Note" className="min-h-28 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-2 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <Icon name="error" className="size-4" /> {error}
        </p>
      )}
    </form>
  )
}
