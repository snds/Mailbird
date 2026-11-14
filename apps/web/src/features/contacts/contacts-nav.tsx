import { useNavPicked } from "@/app/places"
import { FirstGroup } from "@/app/section-switcher"
import type { ContactsPlace } from "@/app/places"
import { useUi } from "@/app/ui-store"
import { IconButton, NavItem, NavSection } from "@unicron/ui"
import { useContacts, useDuplicates } from "@/core/queries"

import { openRestoreContacts } from "./open-restore"
import { openSmartGroupEditor } from "./open-smart-group"
import { useContactsPlace } from "./use-contacts-place"

/**
 * Contacts' second level (ADR-0084; brief X1): everyone, each label, each
 * smart group, and the clean-up tools. Duplicates and Recently deleted are
 * places; Restore contacts opens its form.
 */
export function ContactsNav({ layer = false }: { layer?: boolean }) {
  const at = useContactsPlace()
  const { place, labels, groups } = at
  const settings = useUi((s) => s.settings)
  const picked = useNavPicked()
  // The whole list's length: the same read the list makes with nothing narrowing it.
  const { data: everyone } = useContacts("", null, null)
  const { data: dupes = [] } = useDuplicates()
  const go = (to: ContactsPlace) => {
    useUi.getState().setContactsPlace(to)
    picked()
  }
  const is = (kind: ContactsPlace["kind"]) => !settings && place.kind === kind
  return (
    <>
      <FirstGroup layer={layer} title="Groups" count={1 + labels.length + groups.length}>
        <NavItem label="All contacts" icon="user--multiple" current={is("all")} mark={everyone ? { count: everyone.length, label: `${everyone.length} people` } : undefined} onClick={() => go({ kind: "all" })} />
        {labels.map((l) => (
          <NavItem
            key={l.name}
            label={l.name}
            icon="tag"
            current={is("label") && place.kind === "label" && place.name === l.name}
            mark={{ count: l.count, label: `${l.count} people` }}
            onClick={() => go({ kind: "label", name: l.name })}
          />
        ))}
        {groups.map((g) => (
          <NavItem
            key={g.id}
            label={g.name}
            icon="filter"
            current={is("group") && place.kind === "group" && place.id === g.id}
            mark={{ count: g.count, label: `${g.count} people` }}
            onClick={() => go({ kind: "group", id: g.id })}
            action={
              <IconButton
                label={`Edit smart group ${g.name}`}
                icon="settings--adjust"
                size="icon-xs"
                onClick={() => {
                  picked()
                  openSmartGroupEditor(g)
                }}
              />
            }
          />
        ))}
        <NavItem
          label="New smart group…"
          icon="add"
          onClick={() => {
            picked()
            openSmartGroupEditor()
          }}
        />
      </FirstGroup>
      <NavSection title="Clean up">
        <NavItem
          label="Duplicates"
          icon="merge"
          current={is("duplicates")}
          mark={dupes.length > 0 ? { count: dupes.length, label: `${dupes.length} ${dupes.length === 1 ? "set" : "sets"}` } : undefined}
          onClick={() => go({ kind: "duplicates" })}
        />
        <NavItem label="Recently deleted" icon="trash-can" current={is("deleted")} onClick={() => go({ kind: "deleted" })} />
        <NavItem
          label="Restore contacts"
          icon="recently-viewed"
          onClick={() => {
            picked()
            openRestoreContacts()
          }}
        />
      </NavSection>
    </>
  )
}
