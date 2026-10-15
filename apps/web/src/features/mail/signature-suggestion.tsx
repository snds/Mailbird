import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useContactSuggestion } from "@/core/queries"
import type { ContactSuggestion } from "@/core/types"

// "Not now" lasts for this session: the same message won't ask again until the app restarts.
const dismissed = new Set<string>()

const list = (words: string[]) =>
  words.length < 2 ? (words[0] ?? "") : words.length === 2 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`

/**
 * Under a message whose signature has contact details you don't: offers to
 * add the sender, or the missing phone or title. It opens the contact editor
 * to review, never saves on its own.
 */
export function SignatureSuggestion({ messageId }: { messageId: string }) {
  const { data: s } = useContactSuggestion(messageId)
  const [hidden, setHidden] = useState(() => dismissed.has(messageId))
  if (!s || hidden) return null
  const isNew = s.contactId === null
  const what = list(s.adds.filter((a) => a !== "contact"))
  return (
    <aside className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2.5" aria-label="Contact details in the signature">
      <Icon name={isNew ? "person_add" : "contact_page"} className="size-5 shrink-0 text-vertical-contacts" />
      <p className="min-w-0 flex-1 text-sm">
        {isNew ? (
          <>
            Add <span className="font-medium">{s.card.fullName || s.card.emails[0]?.value}</span> to contacts
            {what && <span className="block text-xs text-muted-foreground">Their signature has a {what}</span>}
          </>
        ) : (
          <>
            Add the {what} from this signature to <span className="font-medium">{s.card.fullName}</span>
          </>
        )}
      </p>
      <Button size="sm" variant="outline" onClick={() => void review(s).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}>
        {isNew ? "Add" : "Review"}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Not now"
        onClick={() => {
          dismissed.add(messageId)
          setHidden(true)
        }}
      >
        <Icon name="close" />
      </Button>
    </aside>
  )
}

/** Opens the editor: a new contact from the card, or yours with the new details filled in. */
async function review(s: ContactSuggestion) {
  const { openContactEditor } = useUi.getState()
  const { card } = s
  if (!s.contactId) {
    openContactEditor({ initial: { fullName: card.fullName, org: card.org, title: card.title, emails: card.emails, phones: card.phones } })
    return
  }
  // The whole card goes in, so saving keeps its note, birthday, and labels.
  const c = await (await getCoreClient()).getContact(s.contactId)
  openContactEditor({
    contactId: c.id,
    initial: { bookId: c.bookId, fullName: c.fullName, org: card.org ?? c.org, title: card.title ?? c.title, emails: card.emails, phones: card.phones, birthday: c.birthday, note: c.note, labels: c.labels },
  })
}
