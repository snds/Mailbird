import { toast } from "sonner"

import { useMailAction } from "@/core/queries"
import type { Address, Category, SenderDecision } from "@/core/types"

import { displayName } from "./format"
import { CATEGORIES } from "./lanes"

const DONE: Record<SenderDecision, (who: string) => string> = {
  allowed: (who) => `${who} can reach your inbox`,
  screened_out: (who) => `Screened out ${who}: their mail skips the inbox`,
  blocked: (who) => `Blocked ${who}`,
}

/** Decide about a sender, or move them to a category, with an Undo. */
export function useSenderActions() {
  const decide = useMailAction<{ email: string; decision: SenderDecision | null }>((c, a) => c.decideSender(a.email, a.decision))
  const move = useMailAction<{ email: string; category: Category | null }>((c, a) => c.setSenderCategory(a.email, a.category))
  return {
    /** `then` runs after it's done, e.g. to close the reader (closing first would drop the toast). */
    decide(from: Address, decision: SenderDecision, then?: () => void) {
      decide.mutate(
        { email: from.email, decision },
        {
          onSuccess: () => {
            toast.success(DONE[decision](displayName(from)), {
              // Undo forgets the decision. Mail already archived stays in Archive.
              action: { label: "Undo", onClick: () => decide.mutate({ email: from.email, decision: null }) },
            })
            then?.()
          },
          onError: (e) => toast.error(e.message),
        },
      )
    },
    move(from: Address, category: Category) {
      move.mutate(
        { email: from.email, category },
        {
          onSuccess: () =>
            toast.success(`Mail from ${displayName(from)} goes to ${CATEGORIES.find((c) => c.id === category)!.label}`, {
              // Back to what the headers say (the row only knows the result, not an earlier override).
              action: { label: "Undo", onClick: () => move.mutate({ email: from.email, category: null }) },
            }),
          onError: (e) => toast.error(e.message),
        },
      )
    },
  }
}
