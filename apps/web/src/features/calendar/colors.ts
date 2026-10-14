import type { Collection } from "@/core/types"

/** A calendar's own color from the server, or the Calendar vertical's accent. */
export const calendarColor = (c: Collection | undefined) => c?.color ?? "var(--c-event-fallback)"

/** CSS custom property for event chips (see `.event-chip` in index.css). */
export const eventStyle = (c: Collection | undefined) => ({ "--event": calendarColor(c) }) as React.CSSProperties
