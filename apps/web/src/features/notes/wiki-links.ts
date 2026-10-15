import type { Editor } from "@tiptap/react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { getCoreClient } from "@/core/client"
import { queryClient, useNotes } from "@/core/queries"

import { linkTitle } from "./wikilink"

/**
 * Opens the note a `[[link]]` names. A link to a note that doesn't exist
 * yet starts it, as Obsidian and Bear do, so you can link first and write
 * later (ADR-0034).
 */
export async function openWikiLink(target: string) {
  const title = linkTitle(target)
  if (!title) return
  try {
    const core = await getCoreClient()
    const id = await core.findNote(title)
    if (id) return useUi.getState().setOpenNote({ id, fresh: false })
    const n = await core.createNote({ markdown: `# ${title}\n` })
    await queryClient.invalidateQueries({ queryKey: ["notes"] })
    useUi.getState().setOpenNote({ id: n.id, fresh: false })
    toast.success(`Started “${title}”`, { duration: 2000 })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

/** The `[[query` being typed before the cursor, if any. */
export interface WikiQuery {
  from: number
  to: number
  query: string
}

export function wikiQueryAt(editor: Editor): WikiQuery | null {
  const { $from, empty } = editor.state.selection
  if (!empty || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼")
  const m = /\[\[([^[\]\n|#]{0,60})$/.exec(before)
  if (!m) return null
  return { from: $from.pos - m[0].length, to: $from.pos, query: m[1]! }
}

export interface Choice {
  title: string
  isNew: boolean
}

/** Notes whose titles match, then "a new note" when none matches exactly. */
export function useWikiChoices(q: WikiQuery | null, currentId: string): Choice[] {
  const query = q?.query.trim() ?? ""
  const { data = [] } = useNotes({ search: query || null, tag: null, archived: false })
  if (!q) return []
  const lower = query.toLowerCase()
  const titles = data.filter((n) => n.id !== currentId && n.title && n.title.toLowerCase().includes(lower)).map((n) => n.title)
  const unique = [...new Set(titles)].slice(0, 6)
  const exact = unique.some((t) => t.toLowerCase() === lower)
  return [...unique.map((title) => ({ title, isNew: false })), ...(query && !exact ? [{ title: query, isNew: true }] : [])]
}

/** Puts a link to `title` where `[[query` was typed. */
export function pickChoice(editor: Editor, q: WikiQuery, title: string) {
  editor
    .chain()
    .focus()
    .insertContentAt({ from: q.from, to: q.to }, [{ type: "wikiLink", attrs: { target: title } }, { type: "text", text: " " }])
    .run()
}
