import { useMemo } from "react"

import { useCollections } from "@/core/queries"

/** Every calendar, by id. */
export function useCalendars() {
  const { data = [] } = useCollections("calendar")
  return useMemo(() => new Map(data.map((c) => [c.id, c])), [data])
}
