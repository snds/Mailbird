import Collaboration from "@tiptap/extension-collaboration"
import { Placeholder } from "@tiptap/extensions"
import { EditorContent, useEditor } from "@tiptap/react"
import { type ReactNode, useState } from "react"
import type * as Y from "yjs"

import { Avatar, AvatarFallback, Button, Icon, IconButton, Textarea } from "@unicron/ui"
import { useMyName } from "@/core/queries"
import { shortTime } from "@/lib/time"

import { MAIL_EXTENSIONS } from "../mail/use-rich-editor"
import { PeopleHere } from "../notes/people-here"
import { initials } from "../mail/format"
import { DRAFT_FIELD, type TeamComment, addComment, removeComment } from "./team-doc"

/**
 * The team's side of a shared conversation (ADR-0060): comments that never
 * leave the team, and the reply everyone writes together. Only the owner
 * sends it, from their own account.
 */
export function TeamPanel({
  doc,
  comments,
  owner,
  from,
  readOnly,
  onUseReply,
  shareId,
  files,
}: {
  /** The conversation's files section (ADR-0061). */
  files?: ReactNode
  /** Shows who else is here in the panel's header (your own conversation's panel). */
  shareId?: string
  doc: Y.Doc
  comments: TeamComment[]
  owner: boolean
  /** Who shared it, for teammates' "who sends it" line. */
  from: string | null
  /** A stopped share: what's here stays, read-only. */
  readOnly: boolean
  /** The owner's way to send the team's reply: it opens in the composer. */
  onUseReply?: (html: string) => void
}) {
  return (
    <section aria-label="Team" className="flex flex-col gap-4 rounded-2xl border px-4 py-4" data-role="team-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Icon name="group" /> Team
        </h3>
        {shareId && <PeopleHere shareId={shareId} />}
      </div>
      <Comments doc={doc} comments={comments} readOnly={readOnly} />
      {files}
      <SharedDraft doc={doc} owner={owner} from={from} readOnly={readOnly} onUseReply={onUseReply} />
    </section>
  )
}

function Comments({ doc, comments, readOnly }: { doc: Y.Doc; comments: TeamComment[]; readOnly: boolean }) {
  const me = useMyName()
  const [text, setText] = useState("")
  const post = () => {
    if (!text.trim()) return
    addComment(doc, me, text)
    setText("")
  }
  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{readOnly ? "No comments." : "Comments stay with the team: they never go to anyone on the conversation."}</p>
      ) : (
        <ol aria-label="Comments" className="flex flex-col gap-3">
          {comments.map((c) => (
            <li key={c.id} className="group flex gap-2.5" data-role="team-comment">
              <Avatar size="sm">
                <AvatarFallback>{initials({ name: c.author, email: c.author })}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium">{c.author}</span>
                  <span className="text-muted-foreground">{shortTime(c.at)}</span>
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">{c.text}</p>
              </div>
              {/* Names are what each person calls themselves, so this only offers to take back your own. */}
              {!readOnly && c.author === me && (
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton icon="delete" label="Delete comment" size="icon-sm" variant="ghost-muted" onClick={() => removeComment(doc, c.id)} />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!readOnly && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            post()
          }}
        >
          <Textarea
            aria-label="Comment"
            placeholder="Comment for the team…"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                post()
              }
            }}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
              Comment
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

/** The reply, written together: live for everyone with the link. */
function SharedDraft({ doc, owner, from, readOnly, onUseReply }: { doc: Y.Doc; owner: boolean; from: string | null; readOnly: boolean; onUseReply?: (html: string) => void }) {
  const editor = useEditor(
    {
      extensions: [
        // Yjs keeps the undo history, per person.
        ...MAIL_EXTENSIONS.map((e) => (e.name === "starterKit" ? e.configure({ heading: false, codeBlock: false, undoRedo: false }) : e)),
        Collaboration.configure({ document: doc, field: DRAFT_FIELD }),
        Placeholder.configure({ placeholder: owner ? "Write the reply together…" : "Help write the reply…" }),
      ],
      immediatelyRender: true,
      editable: !readOnly,
      editorProps: {
        attributes: { role: "textbox", "aria-label": "Reply together", "aria-multiline": "true", class: "team-draft min-h-24 px-3 py-2 text-sm leading-relaxed outline-none" },
      },
    },
    [doc, readOnly],
  )
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Reply together</p>
      <div className="rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/50">
        <EditorContent editor={editor} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{owner ? "Everyone with the link writes here. When it's ready, open it as your reply and send it." : `${from ?? "The person who shared it"} sends it from their account.`}</p>
        {owner && onUseReply && !readOnly && (
          <Button size="sm" onClick={() => editor && onUseReply(editor.isEmpty ? "" : editor.getHTML())}>
            <Icon name="reply" data-icon="inline-start" /> Use as reply
          </Button>
        )}
      </div>
    </div>
  )
}
