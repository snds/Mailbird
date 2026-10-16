import { toast } from "sonner"

import { useUi, type Jump } from "@/app/ui-store"
import type { IconName } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { NoteLinkKind } from "@/core/types"

/** The glyph for each kind of thing a note links to. */
export const LINK_ICON: Record<NoteLinkKind, IconName> = {
  event: "event",
  contact: "person",
  thread: "mail",
}
const LINK_JUMP: Record<NoteLinkKind, Jump["kind"]> = {
  event: "event",
  contact: "contact",
  thread: "thread",
}

/** Opens what a note links to, in its own view. Events open on their next
 * occurrence's day; conversations bring their row. */
export function useOpenLink() {
  const jumpTo = useUi((s) => s.jumpTo)
  return async (kind: NoteLinkKind, target: string) => {
    try {
      const core = await getCoreClient()
      if (kind === "event")
        jumpTo({
          kind: "event",
          id: target,
          start: (await core.getEvent(target)).start,
        })
      else if (kind === "thread")
        jumpTo({
          kind: "thread",
          id: target,
          row: (await core.getThread(target)).at(-1),
        })
      else jumpTo({ kind: LINK_JUMP[kind], id: target })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
}
