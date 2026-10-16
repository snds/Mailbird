import type { Editor } from "@tiptap/react"

import { Icon } from "@unicron/ui"
import { cn } from "@/lib/utils"

import type { Choice, WikiQuery } from "./wiki-links"

/** The list under `[[`, beside the cursor. Clicks keep focus in the editor. */
export function WikiSuggest({ editor, q, choices, active, onPick }: { editor: Editor; q: WikiQuery; choices: Choice[]; active: number; onPick: (c: Choice) => void }) {
  if (choices.length === 0) return null
  const c = editor.view.coordsAtPos(q.from)
  // Keep it on screen on a phone.
  const pos = { top: c.bottom + 4, left: Math.max(8, Math.min(c.left, window.innerWidth - 288)) }
  return (
    <div
      role="listbox"
      id="wiki-suggest"
      aria-label="Link to a note"
      className="fixed z-50 w-72 overflow-hidden rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {choices.map((choice, i) => (
        <div
          key={`${choice.isNew}:${choice.title}`}
          id={`wiki-choice-${i}`}
          role="option"
          aria-selected={i === active}
          className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5", i === active && "bg-accent text-accent-foreground")}
          onClick={() => onPick(choice)}
        >
          <Icon name={choice.isNew ? "note_add" : "description"} tone="muted" className="size-4" />
          <span className="truncate">{choice.isNew ? `New note “${choice.title}”` : choice.title}</span>
        </div>
      ))}
    </div>
  )
}
