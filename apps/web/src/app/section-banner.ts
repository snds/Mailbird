import { useEffect } from "react"
import { create } from "zustand"

import type { VerticalId } from "./verticals"

/**
 * What a section's banner says (ADR-0086; brief X4, cross-app decisions §1,
 * channel 4): something broke, and the person can fix it. One per section,
 * critical, with the one way to fix it.
 */
export interface SectionBanner {
  /** What happened, in a few words: "Work account stopped syncing". */
  title: string
  /** What it means, in the server's words where it has some. */
  body?: string
  /** The way to fix it: "Sign in", "Open Accounts", "Try again". */
  action?: { label: string; onClick: () => void; loading?: boolean }
}

export const useSectionBanners = create<Partial<Record<VerticalId, SectionBanner | null>>>(() => ({}))

/**
 * Puts one critical banner at the top of a section's content while the
 * caller is mounted. Pass the first that applies, or null for none: a
 * section never shows two. Build the banner with `useMemo`, so it is the
 * same object until what it says changes.
 */
export function useSectionBanner(section: VerticalId, banner: SectionBanner | null) {
  useEffect(() => {
    useSectionBanners.setState({ [section]: banner })
    return () => useSectionBanners.setState((s) => (s[section] === banner ? { [section]: null } : s))
  }, [section, banner])
}
