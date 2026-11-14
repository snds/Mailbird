import type { NotesPlace } from "@/app/places"
import { useNavPicked } from "@/app/places"
import { FirstGroup } from "@/app/section-switcher"
import { useUi } from "@/app/ui-store"
import { FieldRow, FilterChip, FilterChipGroup, IconButton, NavItem, NavSection, SectionHeader } from "@unicron/ui"
import { useNoteAction, useNotesPrefs } from "@/core/queries"
import type { NotesPrefs } from "@/core/types"

import { openNoteFolderEditor } from "./open-note-folder"
import { openSharedNote } from "./open-shared-note"
import { useNotesPlace } from "./use-notes-place"

type View = "list" | "cards" | "map"

/**
 * Notes' second level (ADR-0084; brief X1): the folders, which are places,
 * and the tags, which narrow the open folder one at a time. `more` adds the
 * phone sheet's last group: how the notes are drawn.
 */
export function NotesNav({ layer = false, more = false }: { layer?: boolean; more?: boolean }) {
  const { place, folders, tags } = useNotesPlace()
  // Settings or Search stands in the section's place: then none of its rows is the current one.
  const settings = useUi((s) => !!s.settings || !!s.search)
  const picked = useNavPicked()
  const go = (folder: NotesPlace["folder"]) => {
    useUi.getState().setNotesFolder(folder)
    picked()
  }
  const is = (kind: NotesPlace["folder"]["kind"]) => !settings && place.folder.kind === kind
  return (
    <>
      <FirstGroup layer={layer} title="Folders" count={3 + folders.length}>
        <NavItem label="All notes" icon="notebook" current={is("all")} onClick={() => go({ kind: "all" })} />
        <NavItem label="Pinned" icon="pin" current={is("pinned")} onClick={() => go({ kind: "pinned" })} />
        {folders.map((f) => (
          <NavItem
            key={f.id}
            label={f.name}
            icon="folder"
            current={is("folder") && place.folder.kind === "folder" && place.folder.id === f.id}
            mark={{ count: f.count, label: `${f.count} ${f.count === 1 ? "note" : "notes"}` }}
            onClick={() => go({ kind: "folder", id: f.id })}
            action={
              <IconButton
                label={`Edit smart folder ${f.name}`}
                icon="settings--adjust"
                size="icon-xs"
                onClick={() => {
                  picked()
                  openNoteFolderEditor(f)
                }}
              />
            }
          />
        ))}
        <NavItem
          label="New smart folder…"
          icon="add"
          onClick={() => {
            picked()
            openNoteFolderEditor()
          }}
        />
        <NavItem label="Archive" icon="archive" current={is("archive")} onClick={() => go({ kind: "archive" })} />
        <NavItem
          label="Open a shared note…"
          icon="user--follow"
          onClick={() => {
            picked()
            openSharedNote()
          }}
        />
      </FirstGroup>
      {tags.length > 0 && (
        // Filters, one at a time: each a checkbox, so the tag in force clears on a second pick. Never "current".
        <NavSection title="Tags" count={tags.length} checkable="multiple">
          {tags.map((t) => (
            <NavItem
              key={t.tag}
              label={`#${t.tag}`}
              checked={place.tag === t.tag}
              onCheckedChange={() => {
                const ui = useUi.getState()
                // The Archive has no tags: a tag picked there narrows all notes.
                if (place.folder.kind === "archive") ui.setNotesFolder({ kind: "all" })
                ui.setNotesTag(t.tag)
                picked()
              }}
            />
          ))}
        </NavSection>
      )}
      {more && <NotesMore />}
    </>
  )
}

/** The phone sheet's last group (brief X1): the notes as a list, as cards, or as the map of their links. */
function NotesMore() {
  const { data: prefs } = useNotesPrefs()
  const picked = useNavPicked()
  const setPrefs = useNoteAction((c, change: Partial<NotesPrefs>) => c.setNotesPrefs({ sortChecked: true, ...prefs, ...change }))
  const view: View = prefs?.graph ? "map" : prefs?.grid ? "cards" : "list"
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title="More" level={3} />
      <FieldRow size="stacked" rule="none" label="View">
        <FilterChipGroup
          label="View"
          value={view}
          onValueChange={(v) => {
            // The map keeps the choice between list and cards underneath it.
            setPrefs.mutate(v === "map" ? { graph: true } : { graph: false, grid: v === "cards" })
            picked()
          }}
        >
          <FilterChip value="list">List</FilterChip>
          <FilterChip value="cards">Cards</FilterChip>
          <FilterChip value="map">Map</FilterChip>
        </FilterChipGroup>
      </FieldRow>
    </section>
  )
}
