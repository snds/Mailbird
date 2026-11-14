import { stepBack, type SearchScope } from "@/app/places"
import { useUi } from "@/app/ui-store"

import { focusSearchField } from "./field"

/**
 * Opens Search and puts the cursor in its field (ADR-0085). From a section
 * it looks through that section's kind (in Mail, the lane you are in); pass
 * a scope to say otherwise. Already open, it keeps its words.
 */
export function openSearch(scope?: SearchScope, query?: string) {
  useUi.getState().openSearch(scope, query)
  focusSearchField()
}

/**
 * Leaves Search for where you came from: the browser's Back when the place
 * behind is that one, so the two never disagree; otherwise by hand.
 */
export function leaveSearch() {
  stepBack((behind) => behind.search === null, () => useUi.getState().closeSearch())
}
