import { Placeholder } from "@tiptap/extensions"
import { Extension, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"

/** Leaves Mod-Enter to the composer form (send) instead of inserting a line break. */
const SendKey = Extension.create({
  name: "sendKey",
  priority: 1000,
  addKeyboardShortcuts: () => ({ "Mod-Enter": () => true }),
})

/** Only web and mail links; Tiptap's own check already refuses `javascript:`. */
export const SAFE_LINK = /^(https?:|mailto:)/i

/**
 * `focusFirst` marks the body as the composer's first focus. The dialog does
 * the focusing once it is open (see Composer), which Tiptap's own autofocus
 * can't time reliably inside an opening dialog.
 */
export function useRichEditor({ html, placeholder, focusFirst }: { html: string; placeholder: string; focusFirst: boolean }) {
  return useEditor({
    extensions: [
      // Email-sized formatting: no headings or code blocks.
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url, ctx) => SAFE_LINK.test(url) && ctx.defaultValidate(url) },
      }),
      Placeholder.configure({ placeholder }),
      SendKey,
    ],
    content: html,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Message",
        "aria-multiline": "true",
        ...(focusFirst ? { "data-composer-focus": "" } : {}),
        class: "composer-body min-h-48 flex-1 px-4 py-3 text-[15px] leading-relaxed outline-none",
      },
    },
  })
}
