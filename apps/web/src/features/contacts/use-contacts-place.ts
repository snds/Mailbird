import type { ContactsPlace } from "@/app/places"
import { useUi } from "@/app/ui-store"
import { useContactLabels, useSmartGroups } from "@/core/queries"

/**
 * Contacts' place as it stands: the one in the store, unless its label or
 * smart group is gone (its last card edited, the group deleted); then
 * everyone. The nav and the view both read it.
 */
export function useContactsPlace() {
  const stored = useUi((s) => s.contactsPlace)
  const { data: labels = [], isPending: labelsPending } = useContactLabels()
  const { data: groups = [], isPending: groupsPending } = useSmartGroups()
  const label = stored.kind === "label" ? (labels.find((l) => l.name === stored.name) ?? null) : null
  const group = stored.kind === "group" ? (groups.find((g) => g.id === stored.id) ?? null) : null
  // While the lists are still arriving, the stored place is trusted.
  const gone = (stored.kind === "label" && !label && !labelsPending) || (stored.kind === "group" && !group && !groupsPending)
  const place: ContactsPlace = gone ? { kind: "all" } : stored
  return { place, label, group, labels, groups }
}

/** What a contacts place is called: the breadcrumb, the page head, the sheet's overline. */
export function contactsPlaceName(at: ReturnType<typeof useContactsPlace>) {
  const { place } = at
  if (place.kind === "label") return place.name
  if (place.kind === "group") return at.group?.name ?? "Smart group"
  if (place.kind === "duplicates") return "Duplicates"
  if (place.kind === "deleted") return "Recently deleted"
  return "All contacts"
}
