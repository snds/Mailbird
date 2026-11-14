/**
 * The Search field, for the ways in that land on it (ADR-0085): the search
 * key, the phone's search button and the sidebar's item all put the cursor
 * in it, whether Search has just opened or was open already.
 */
let field: HTMLInputElement | null = null

/** The Search screen hands its field over while it is mounted. */
export const setSearchField = (el: HTMLInputElement | null) => {
  field = el
}

/** Puts the cursor in the field, with its words selected, once the screen is there. */
export function focusSearchField() {
  requestAnimationFrame(() => {
    field?.focus()
    field?.select()
  })
}
