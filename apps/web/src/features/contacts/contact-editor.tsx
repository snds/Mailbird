import { useState } from "react"
import { toast } from "sonner"

import { useUi, type ContactEditorState } from "@/app/ui-store"
import { EditorFrame, EditorHeader } from "@/components/editor-frame"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { getCoreClient } from "@/core/client"
import { useAccounts, useCollections, useContactLabels, usePimAction } from "@/core/queries"
import type { ContactField, ContactInput } from "@/core/types"

import { PersonAvatar } from "./person"

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

/**
 * A picked image as a square JPEG photo: centered crop, 256 px, quality 0.85.
 * Small enough (tens of KB) to sync with the card to any server and phone.
 */
async function toPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can open")
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 256
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
  bitmap.close()
  return canvas.toDataURL("image/jpeg", 0.85)
}

/** The card's photo: add, change, or remove. `undefined` means untouched. */
function PhotoField({ name, value, onChange }: { name: string; value: string | null; onChange: (v: string | null) => void }) {
  const pick = (files: FileList | null) => {
    const f = files?.[0]
    if (f) void toPhoto(f).then(onChange, (e: Error) => toast.error(e.message))
  }
  return (
    <div className="flex items-center gap-4 border-b px-4 py-3" role="group" aria-label="Photo">
      <PersonAvatar contact={{ fullName: name || "?", photo: value }} className="size-16 text-lg" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" render={<label />}>
          <Icon name="add_a_photo" data-icon="inline-start" /> {value ? "Change photo" : "Add photo"}
          <input type="file" accept="image/*" aria-label={value ? "Change photo" : "Add photo"} className="sr-only" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
        </Button>
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove photo
          </Button>
        )}
      </div>
    </div>
  )
}

/** Labels as removable chips, plus a field that suggests labels already in use. */
function LabelField({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const { data: known = [] } = useContactLabels()
  const [draft, setDraft] = useState("")
  const add = (raw: string) => {
    const l = raw.trim().replace(/,/g, " ")
    // Reuse an existing label's spelling, so "clay club" joins "Clay club".
    const name = known.find((k) => k.name.toLowerCase() === l.toLowerCase())?.name ?? l
    if (name && !values.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...values, name])
    setDraft("")
  }
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b px-4 py-2" role="group" aria-label="Labels">
      <span className="w-24 shrink-0 text-sm text-muted-foreground">Labels</span>
      {values.map((l) => (
        <span key={l} className="inline-flex h-7 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs font-medium">
          {l}
          <button type="button" aria-label={`Remove label ${l}`} className="flex size-5 items-center justify-center rounded-full hover:bg-foreground/10" onClick={() => onChange(values.filter((v) => v !== l))}>
            <Icon name="close" className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        className="h-8 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder={values.length ? "Add" : "Add a label"}
        aria-label="Add a label"
        list="contact-label-options"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && add(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault()
            // Enter adds a label here; it doesn't submit the form.
            e.stopPropagation()
            if (draft.trim()) add(draft)
          } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1))
        }}
      />
      <datalist id="contact-label-options">
        {known.filter((k) => !values.some((v) => v.toLowerCase() === k.name.toLowerCase())).map((k) => (
          <option key={k.name} value={k.name} />
        ))}
      </datalist>
    </div>
  )
}

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
  const [labels, setLabels] = useState<string[]>(initial.labels ?? [])
  const [photo, setPhoto] = useState<string | null>(initial.photo ?? null)
  const photoChanged = photo !== (initial.photo ?? null)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState("")
  // Fills the form from a pasted signature; what you've typed stays unless the signature has it.
  const fillFrom = async () => {
    const card = await (await getCoreClient()).parseSignature(pasted)
    if (card.fullName) setFullName(card.fullName)
    if (card.org) setOrg(card.org)
    if (card.title) setTitle(card.title)
    const kept = <T extends ContactField>(have: T[], more: T[]) => [...have.filter((f) => f.value.trim()), ...more.filter((m) => !have.some((h) => h.value.trim().toLowerCase() === m.value.trim().toLowerCase()))]
    if (card.emails.length) setEmails((e) => kept(e, card.emails))
    if (card.phones.length) setPhones((p) => kept(p, card.phones))
    const found = [card.fullName && "name", card.title && "title", card.org && "company", card.phones.length && "phone", card.emails.length && "email"].filter(Boolean)
    if (found.length) {
      toast.success(`Filled in ${found.join(", ")}`, { duration: 2500 })
      setPasting(false)
      setPasted("")
    } else toast.error("Couldn't find a name, phone, or email in that text")
  }
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
      // An editor opened without the card's labels leaves them alone.
      labels: initial.labels !== undefined || labels.length ? labels : null,
      // Only a changed photo is sent; "" removes it.
      ...(photoChanged ? { photo: photo ?? "" } : {}),
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
        {!contactId &&
          (pasting ? (
            <div className="flex flex-col gap-2 border-b bg-muted/40 px-4 py-3">
              <textarea
                aria-label="Signature"
                placeholder={"Paste an email signature, like:\nPriya Raman\nDesign systems lead | Studio\nm: +1 555 010 4410"}
                className="min-h-28 w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPasting(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={!pasted.trim()} onClick={() => void fillFrom().catch((e) => toast.error(String(e)))}>
                  Fill in
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" className="flex h-11 w-full items-center gap-2 border-b px-4 text-sm text-primary hover:bg-muted/50" onClick={() => setPasting(true)}>
              <Icon name="content_paste" className="size-4" /> Paste a signature to fill this in
            </button>
          ))}
        <PhotoField name={fullName} value={photo} onChange={setPhoto} />
        <div className="border-b px-4 py-2">
          <input aria-label="Name" placeholder="Name" autoComplete="name" className="h-11 w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground" value={fullName} onChange={(e) => setFullName(e.target.value)} data-editor-focus="" />
          <input aria-label="Company" placeholder="Company" autoComplete="organization" className={`${bare} w-full`} value={org} onChange={(e) => setOrg(e.target.value)} />
          <input aria-label="Job title" placeholder="Job title" className={`${bare} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <FieldList kind="email" values={emails} onChange={setEmails} labels={EMAIL_LABELS} />
        <FieldList kind="phone" values={phones} onChange={setPhones} labels={PHONE_LABELS} />
        <LabelField values={labels} onChange={setLabels} />
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
