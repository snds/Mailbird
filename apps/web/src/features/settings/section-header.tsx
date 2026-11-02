import type { ReactNode } from "react"

import { IconButton } from "@unicron/ui"

/**
 * A settings section's title and what it's for (ADR-0075). With `onBack`, a
 * step inside the section (adding an account) with a way back to it.
 */
export function SectionHeader({ title, description, onBack }: { title: ReactNode; description?: ReactNode; onBack?: () => void }) {
  return (
    <header className="flex flex-col gap-1">
      <h2 className="type-section-title flex items-center gap-1">
        {onBack && <IconButton icon="arrow_back" label="Back" variant="ghost" size="icon-sm" onClick={onBack} />}
        {title}
      </h2>
      {description && <p className="type-support">{description}</p>}
    </header>
  )
}

/** A section form's actions, at its end. */
export function SectionActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">{children}</div>
}
