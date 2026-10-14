import { useQuery } from "@tanstack/react-query"
import { useDeferredValue, useId, useState } from "react"

import { getCoreClient } from "@/core/client"
import type { Address } from "@/core/types"
import { cn } from "@/lib/utils"

const format = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email)

/** The address being typed: whatever follows the last separator. */
const lastToken = (text: string) => text.split(/[,;]/).at(-1)!.trimStart()

/**
 * A comma-separated recipients field with suggestions from Contacts
 * (WAI-ARIA combobox: arrows move, Enter or Tab picks, Escape closes).
 */
export function RecipientInput({ id, value, onChange, className, ...rest }: { id: string; value: string; onChange: (v: string) => void; className?: string } & Omit<React.ComponentProps<"input">, "value" | "onChange" | "id">) {
  const listId = useId()
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const token = useDeferredValue(lastToken(value))
  const { data: suggestions = [] } = useQuery({
    queryKey: ["pim", "suggest", token],
    queryFn: async () => (await getCoreClient()).suggestRecipients(token),
    enabled: token.length >= 1,
    placeholderData: (prev) => prev,
  })
  // Don't suggest what's already in the field.
  const fresh = token.length >= 1 ? suggestions.filter((s) => !value.toLowerCase().includes(s.email.toLowerCase())) : []
  const open = fresh.length > 0 && dismissed !== token
  const index = Math.min(active, fresh.length - 1)

  const pick = (a: Address) => {
    const head = value.slice(0, value.length - lastToken(value).length)
    onChange(`${head}${format(a)}, `)
    setActive(0)
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${index}` : undefined}
        className={cn("w-full", className)}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setActive(0)
          setDismissed(null)
        }}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === "ArrowDown") setActive((i) => (i + 1) % fresh.length)
          else if (e.key === "ArrowUp") setActive((i) => (i - 1 + fresh.length) % fresh.length)
          else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") pick(fresh[index]!)
          else if (e.key === "Escape") {
            // Close the list, not the composer.
            e.stopPropagation()
            setDismissed(token)
          } else return
          e.preventDefault()
        }}
        onBlur={() => setDismissed(token)}
        autoComplete="off"
        {...rest}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
          {fresh.map((s, i) => (
            <li
              key={s.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              // mousedown, not click: picking must not blur the input first.
              onMouseDown={(e) => (e.preventDefault(), pick(s))}
              className="flex cursor-default flex-col rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-accent"
            >
              <span className="truncate font-medium">{s.name ?? s.email}</span>
              {s.name && <span className="truncate text-xs text-muted-foreground">{s.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
