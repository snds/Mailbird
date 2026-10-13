import { useSyncExternalStore } from "react"

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Matches Tailwind's `md` breakpoint, where the layout gains a nav rail. */
export const useIsTabletUp = () => useMediaQuery("(min-width: 768px)")
