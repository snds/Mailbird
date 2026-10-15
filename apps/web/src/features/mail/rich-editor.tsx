import { EditorContent, useEditorState, type Editor } from "@tiptap/react"
import { useState } from "react"

import { Icon, type IconName } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { SAFE_LINK } from "./use-rich-editor"

export function RichEditor({ editor }: { editor: Editor }) {
  return <EditorContent editor={editor} className="flex min-h-0 flex-1 flex-col overflow-y-auto [&>div]:flex-1" />
}

export function Mark({ icon, label, shortcut, pressed, onPressedChange }: { icon: IconName; label: string; shortcut?: string; pressed: boolean; onPressedChange: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Toggle size="sm" aria-label={label} pressed={pressed} onPressedChange={onPressedChange} />}>
        <Icon name={icon} />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-2 font-mono text-[11px] opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

/** `notes` adds what notes need beyond mail: headings, checklists, and code. */
export function FormatBar({ editor, notes = false }: { editor: Editor; notes?: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      heading: e.isActive("heading"),
      task: e.isActive("taskList"),
      code: e.isActive("codeBlock"),
    }),
  })
  const [linking, setLinking] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const chain = () => editor.chain().focus()

  const applyLink = () => {
    const url = linking?.trim() ?? ""
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : url.includes("@") && !url.includes("/") ? `mailto:${url}` : `https://${url}`
    // Keep the field open on a refused scheme so the writer sees why nothing happened.
    if (url && !SAFE_LINK.test(href)) return setRefused(true)
    // Move focus back synchronously, before the field unmounts; otherwise the
    // dialog's focus trap catches it and parks it on the popup.
    editor.view.focus()
    setLinking(null)
    setRefused(false)
    if (!url) return chain().extendMarkRange("link").unsetLink().run()
    if (editor.state.selection.empty && !state.link) {
      // Nothing selected: insert the address itself as the link text.
      chain().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href } }] }).run()
    } else {
      chain().extendMarkRange("link").setLink({ href }).run()
    }
  }

  return (
    <div className="flex flex-col border-t" role="toolbar" aria-label="Formatting">
      {linking !== null && (
        // A div, not a form: this sits inside the composer's form.
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <Icon name="link" className="size-4 text-muted-foreground" />
          <input
            aria-label="Link address"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="https://… or name@example.com"
            value={linking}
            autoFocus
            inputMode="url"
            aria-invalid={refused || undefined}
            aria-describedby={refused ? "link-refused" : undefined}
            onChange={(e) => (setLinking(e.target.value), setRefused(false))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                applyLink()
              } else if (e.key === "Escape") {
                // Close the link field, not the whole composer.
                e.preventDefault()
                e.stopPropagation()
                editor.view.focus()
                setLinking(null)
                setRefused(false)
              }
            }}
          />
          {refused && (
            <span id="link-refused" className="text-xs text-destructive">
              Only web and email links
            </span>
          )}
          <Button type="button" size="sm" variant="secondary" onClick={applyLink}>
            {linking.trim() ? "Apply" : "Remove"}
          </Button>
        </div>
      )}
      {/* Pressing a format button must not take focus (or the phone keyboard) from the editor. */}
      {/* In notes on phones, keep clear of the floating New note button. */}
      <div className={cn("flex items-center gap-0.5 overflow-x-auto px-2 py-1", notes && "max-md:pr-24")} onMouseDown={(e) => e.preventDefault()}>
        {notes && (
          <>
            <Mark icon="title" label="Heading" pressed={state.heading} onPressedChange={() => chain().toggleHeading({ level: 2 }).run()} />
            <Mark icon="checklist" label="Checklist" pressed={state.task} onPressedChange={() => chain().toggleTaskList().run()} />
            {/* Starts [[ so the note picker opens: easier than finding brackets on a phone keyboard. */}
            <Mark icon="add_link" label="Link to a note" pressed={false} onPressedChange={() => chain().insertContent("[[").run()} />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
          </>
        )}
        <Mark icon="format_bold" label="Bold" shortcut={`${mod}B`} pressed={state.bold} onPressedChange={() => chain().toggleBold().run()} />
        <Mark icon="format_italic" label="Italic" shortcut={`${mod}I`} pressed={state.italic} onPressedChange={() => chain().toggleItalic().run()} />
        <Mark
          icon="link"
          label="Link"
          pressed={state.link || linking !== null}
          onPressedChange={() => setLinking(linking !== null ? null : ((editor.getAttributes("link").href as string | undefined) ?? ""))}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Mark icon="format_list_bulleted" label="Bulleted list" pressed={state.bullet} onPressedChange={() => chain().toggleBulletList().run()} />
        <Mark icon="format_list_numbered" label="Numbered list" pressed={state.ordered} onPressedChange={() => chain().toggleOrderedList().run()} />
        <Mark icon="format_quote" label="Quote" pressed={state.quote} onPressedChange={() => chain().toggleBlockquote().run()} />
        {notes && <Mark icon="code_blocks" label="Code block" pressed={state.code} onPressedChange={() => chain().toggleCodeBlock().run()} />}
      </div>
    </div>
  )
}
