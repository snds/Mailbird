// In-memory notes for the web demo. Follows crates/core/src/notes_store.rs
// and notes_import.rs where the UI can tell: first-line titles, pinned
// first, word-prefix search over title, text, and tags, tombstones for
// sync, newest-record-wins merges, and the same import formats.

import { downloadNotes } from "@/lib/download"

import type { CoreEvent } from "./client"
import { NOTE_COLORS } from "./types"
import type { ImportFile, ImportReport, NoteDetail, NoteInput, NoteLink, NoteMeta, NoteQuery, NoteRecord, NoteColor, NoteSummary, NoteTarget, NoteTask, NotesPrefs, PlannedTask, RelayConfig, TagCount } from "./types"

interface DemoNote extends NoteRecord {
  markdown: string
  ydoc: string | null
  source: string | null
}

export interface DemoLinks {
  /** The link for something in the demo's mail, calendar, or contacts. */
  linkFor(target: NoteTarget): NoteLink | null
  /** Its id in the demo, if it's there. */
  resolve(link: NoteLink): string | null
  /** For the sample notes: an event or contact by its title or name. */
  byName(kind: "event" | "contact", name: string): NoteLink | null
  /** An event by its UID, for tasks planned on the calendar. */
  eventByUid(uid: string): { id: string; title: string; start: number; end: number } | null
}

const now = () => Math.floor(Date.now() / 1000)
const SNIPPET = 140

/** One Markdown line as plain text (same rules as the core). */
function plainLine(line: string): string {
  let l = line.trim()
  if (l.startsWith("```") || /^[-*_= ]*$/.test(l)) return ""
  l = l.replace(/^>\s*/, "").replace(/^#+\s*/, "")
  l = l.replace(/^([-*+] \[[ xX]\] |[-*+] |\d+\. )/, "")
  l = l.replace(/\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g, (_, t: string, shown?: string) => shown ?? t)
  l = l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Markdown's escapes (`\[`, `\#`) read as the plain character.
  return l.replace(/\*\*|__|~~|[`*]/g, "").replace(/\\([!-/:-@[-`{-~])/g, "$1").trim()
}

/** The `[[wikilinks]]` in Markdown as target titles, skipping code (notes_store.rs). */
export function wikilinks(markdown: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced
    if (fenced) continue
    const plain = line.replace(/`[^`]*`/g, "")
    for (const m of plain.matchAll(/\[\[([^[\]|\n]+?)(?:\|[^[\]\n]+?)?\]\]/g)) {
      const t = m[1]!.split("#")[0]!.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/** A title as a file name, as the core makes it. */
const fileStem = (title: string) => {
  const s = title.replace(/[/\\:*?"<>|#^[\]\p{Cc}]/gu, " ").split(/\s+/).filter(Boolean).join(" ").replace(/^\.+|\.+$/g, "").trim()
  return s ? s.slice(0, 120) : "Untitled"
}
const yamlText = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")

export function titleAndSnippet(markdown: string): [string, string] {
  const lines = markdown.split("\n").map(plainLine).filter(Boolean)
  const title = (lines.shift() ?? "").slice(0, 200)
  let snippet = ""
  for (const l of lines) {
    if (snippet.length >= SNIPPET) break
    snippet += (snippet ? " " : "") + l
  }
  if (snippet.length > SNIPPET) snippet = `${snippet.slice(0, SNIPPET).trimEnd()}…`
  return [title, snippet]
}

/** A note's checklist items in document order, skipping code blocks (tasks_store.rs). */
export function tasksIn(markdown: string): [boolean, string][] {
  const out: [boolean, string][] = []
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = /^\s*[-*+] \[([ xX])\](?: (.*))?$/.exec(line)
    if (m) out.push([m[1] !== " ", plainLine(m[2] ?? "")])
  }
  return out
}

export function cleanTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, "").split(/\s+/).filter(Boolean).join(" ")
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}

function cleanLinks(links: NoteLink[]): NoteLink[] {
  const out: NoteLink[] = []
  for (const l of links) {
    if (l.key && !out.some((o) => o.kind === l.kind && o.key === l.key)) out.push({ kind: l.kind, key: l.key, label: l.label, target: null })
  }
  return out
}

/** A known color or none, like clean_color: a newer device's color shows as the plain card. */
function cleanColor(c: string | null | undefined): NoteColor | null {
  const k = (c ?? "").trim().toLowerCase()
  return (NOTE_COLORS as readonly string[]).includes(k) ? (k as NoteColor) : null
}

/** Keep's Takeout names: two blues fold into ours, DEFAULT is none. */
const keepColor = (c: unknown) => (c === "CERULEAN" ? "blue" : typeof c === "string" ? cleanColor(c) : null)

export function createDemoNotes(emit: (e: CoreEvent, payload?: unknown) => void, later: <T>(v: T) => Promise<T>, links: DemoLinks) {
  const t = now()
  const DAY = 86_400
  let n = 0
  const note = (markdown: string, ago: number, extra: Partial<DemoNote> = {}): DemoNote => ({
    id: `note-${++n}`, markdown, ydoc: null, pinned: false, archived: false, deleted: false, color: null, remindAt: null, tags: [], links: [],
    created: t - ago - DAY, updated: t - ago, source: null, ...extra,
  })
  const event = (title: string) => links.byName("event", title)
  const notes: DemoNote[] = [
    note("Cabin packing list\n\n- [ ] Board games\n- [ ] Coffee + grinder\n- [x] Rain jackets\n- [ ] Ferry tickets (in Mail)", 2 * 3600, {
      pinned: true, color: "green", tags: ["trip"], links: [event("Cabin weekend")].filter((l): l is NoteLink => !!l),
    }),
    note("Design review agenda\n\n1. Token drift in the **semantic** tier\n2. List density on phones\n3. Mobile tab bar labels\n\nBackground: [[Icon axis ideas]]", 5 * 3600, {
      tags: ["work"], links: [event("Design review")].filter((l): l is NoteLink => !!l),
    }),
    note("Icon axis ideas\n\nFill animates on selection. Grade drops in dark mode. Optical size follows the rendered px size.", DAY, { color: "purple", tags: ["design"] }),
    note("Gift ideas for Marcus\n\n- A good hand grinder\n- *Wingspan* expansion", 3 * DAY, {
      color: "yellow", tags: ["home"], links: [links.byName("contact", "Marcus Lee")].filter((l): l is NoteLink => !!l),
    }),
    note("Old color experiments\n\nOKLCH ramps with a fixed chroma cap.", 40 * DAY, { archived: true, tags: ["design"] }),
  ]
  let prefs: NotesPrefs = { sortChecked: true, grid: false }
  let relay: RelayConfig | null = null
  try {
    const saved = localStorage.getItem("mailbird.demo.relay")
    relay = saved ? (JSON.parse(saved) as RelayConfig) : null
  } catch {
    relay = null
  }

  const changed = () => emit("notes:changed")

  // Note reminders (ADR-0039) come through the same "reminder" event as the
  // calendar's, checked on the same beat; each fires once.
  let checked = now()
  setInterval(() => {
    const until = now()
    notes
      .filter((x) => !x.deleted && !x.archived && x.remindAt && x.remindAt > checked && x.remindAt <= until)
      .sort((a, b) => a.remindAt! - b.remindAt!)
      .forEach((x) => emit("reminder", { eventId: "", noteId: x.id, title: titleAndSnippet(x.markdown)[0], location: null, start: x.remindAt!, fireAt: x.remindAt! }))
    checked = until
  }, 5000)
  const find = (id: string) => {
    const x = notes.find((k) => k.id === id && !k.deleted)
    if (!x) throw new Error("that note is gone")
    return x
  }
  const summary = (x: DemoNote): NoteSummary => {
    const [title, snippet] = titleAndSnippet(x.markdown)
    return {
      id: x.id, title, snippet, pinned: x.pinned, archived: x.archived, color: x.color ?? null, remindAt: x.remindAt ?? null, tags: [...x.tags],
      links: x.links.map((l) => ({ ...l, target: links.resolve(l) })), created: x.created, updated: x.updated,
    }
  }
  const detail = (x: DemoNote): NoteDetail => ({ ...summary(x), markdown: x.markdown, ydoc: x.ydoc })
  const record = ({ markdown: _m, ydoc: _y, source: _s, ...r }: DemoNote): NoteRecord => structuredClone(r)
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const matches = (x: DemoNote, search: string) => {
    const hay = [...words(x.markdown), ...x.tags.flatMap(words)]
    return words(search).every((w) => hay.some((h) => h.startsWith(w)))
  }
  const linkingTo = (title: string, except: string | null) => {
    const t = title.trim().toLowerCase()
    if (!t) return []
    return notes
      .filter((x) => !x.deleted && x.id !== except && wikilinks(x.markdown).some((w) => w.toLowerCase() === t))
      .sort((a, b) => b.updated - a.updated)
      .map(summary)
  }
  const bump = (x: DemoNote) => (x.updated = Math.max(now(), x.updated + 1))

  return {
    listNotes: async (q: NoteQuery) => {
      let linkKey: NoteLink | null = null
      if (q.linked) {
        linkKey = links.linkFor(q.linked)
        if (!linkKey) return later([])
      }
      const out = notes
        .filter((x) => !x.deleted && x.archived === !!q.archived)
        .filter((x) => !q.search?.trim() || matches(x, q.search))
        .filter((x) => !q.tag || x.tags.some((g) => g.toLowerCase() === q.tag!.toLowerCase()))
        .filter((x) => !linkKey || x.links.some((l) => l.kind === linkKey.kind && l.key === linkKey.key))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated)
        .map(summary)
      return later(out)
    },
    getNote: async (id: string) => later(detail(find(id))),
    // Connected notes (ADR-0034), as the core does them.
    noteBacklinks: async (id: string) => later(linkingTo(titleAndSnippet(find(id).markdown)[0], id)),
    notesLinkingTo: async (title: string, except: string | null) => later(linkingTo(title, except)),
    findNote: async (title: string) => {
      const t = title.split("#")[0]!.trim().toLowerCase()
      const hit = t ? notes.filter((x) => !x.deleted && titleAndSnippet(x.markdown)[0].toLowerCase() === t).sort((a, b) => b.updated - a.updated)[0] : undefined
      return later(hit?.id ?? null)
    },
    exportNotes: async () => {
      const taken = new Set<string>()
      const files = notes
        .filter((x) => !x.deleted)
        .sort((a, b) => a.created - b.created)
        .map((x) => {
          const title = titleAndSnippet(x.markdown)[0]
          const stem = fileStem(title)
          let path = `${stem}.md`
          for (let i = 2; taken.has(path.toLowerCase()); i++) path = `${stem} ${i}.md`
          taken.add(path.toLowerCase())
          let fm = `---\ntitle: ${yamlText(title)}\n`
          if (x.tags.length) fm += `tags:\n${x.tags.map((t) => `  - ${yamlText(t)}\n`).join("")}`
          fm += `created: ${iso(x.created)}\nupdated: ${iso(x.updated)}\n`
          if (x.pinned) fm += "pinned: true\n"
          if (x.archived) fm += "archived: true\n"
          if (x.color) fm += `color: ${x.color}\n`
          return { path, contents: `${fm}---\n${x.markdown.trimEnd()}\n` }
        })
      return downloadNotes(files)
    },
    createNote: async (input: NoteInput) => {
      // Random ids, like the core's UUIDs: two devices never mint the same one.
      const x = note(input.markdown, 0, { id: crypto.randomUUID(), pinned: !!input.pinned, tags: cleanTags(input.tags ?? []), links: cleanLinks(input.links ?? []), created: now(), updated: now() })
      notes.push(x)
      changed()
      return later(detail(x))
    },
    saveNoteBody: async (id: string, markdown: string, ydoc: string | null, touch: boolean) => {
      const x = notes.find((k) => k.id === id)
      if (!x) throw new Error("that note is gone")
      if (touch && x.markdown !== markdown) bump(x)
      x.markdown = markdown
      if (ydoc) x.ydoc = ydoc
      changed()
    },
    setNoteMeta: async (id: string, meta: NoteMeta) => {
      const x = find(id)
      if (meta.pinned !== undefined) x.pinned = meta.pinned
      if (meta.archived !== undefined) x.archived = meta.archived
      if (meta.color !== undefined) x.color = cleanColor(meta.color)
      if (meta.remindAt !== undefined) x.remindAt = meta.remindAt > 0 ? meta.remindAt : null
      if (meta.tags) x.tags = cleanTags(meta.tags)
      if (meta.links) x.links = cleanLinks(meta.links)
      bump(x)
      changed()
      return later(summary(x))
    },
    deleteNote: async (id: string) => {
      const x = find(id)
      x.deleted = true
      bump(x)
      changed()
    },
    restoreNote: async (id: string) => {
      const x = notes.find((k) => k.id === id)
      if (!x) throw new Error("that note is gone")
      x.deleted = false
      bump(x)
      changed()
    },
    noteTags: async () => {
      const counts = new Map<string, TagCount>()
      for (const x of notes.filter((k) => !k.deleted && !k.archived)) {
        for (const tag of x.tags) {
          const c = counts.get(tag.toLowerCase()) ?? { tag, count: 0 }
          c.count++
          counts.set(tag.toLowerCase(), c)
        }
      }
      return later([...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
    },
    noteTasks: async (done = false) => {
      const out: NoteTask[] = []
      const at = now()
      for (const x of notes.filter((k) => !k.deleted && !k.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated)) {
        const items = tasksIn(x.markdown)
        if (!items.length) continue
        const events = x.links.filter((l) => l.kind === "event").map((l) => links.eventByUid(l.key)).filter((e) => !!e)
        items.forEach(([isDone, text], index) => {
          if (!text || (isDone && !done)) return
          // Same pick as the core: the next block to come, else the latest.
          let planned: PlannedTask | null = null
          for (const e of events.filter((e) => e.title.toLowerCase() === text.toLowerCase())) {
            const p = { eventId: e.id, start: e.start, end: e.end }
            const up = (q: PlannedTask) => (q.end ?? q.start) >= at
            if (!planned || (up(p) && (!up(planned) || p.start < planned.start)) || (!up(p) && !up(planned) && p.start > planned.start)) planned = p
          }
          out.push({ noteId: x.id, noteTitle: titleAndSnippet(x.markdown)[0], index, text, done: isDone, planned })
        })
      }
      return later(out)
    },
    notesPrefs: async () => later({ ...prefs }),
    setNotesPrefs: async (p: NotesPrefs) => {
      prefs = { ...p }
      changed()
      return later({ ...prefs })
    },
    noteLinkFor: async (target: NoteTarget) => later(links.linkFor(target)),
    importNotes: async (files: ImportFile[]) => {
      const { parsed, report } = parseImport(files)
      for (const p of parsed) {
        if (notes.some((x) => x.source === p.source)) {
          report.duplicates++
          continue
        }
        notes.push(note(p.markdown, 0, { ...p, id: crypto.randomUUID(), tags: cleanTags(p.tags) }))
        report.imported++
      }
      changed()
      return later(report)
    },
    noteRecords: async () => later(notes.map(record)),
    applyNoteRecords: async (records: NoteRecord[]) => {
      const ids: string[] = []
      for (const r of records) {
        const x = notes.find((k) => k.id === r.id)
        const clean = { ...structuredClone(r), color: cleanColor(r.color), remindAt: r.remindAt && r.remindAt > 0 ? r.remindAt : null, tags: cleanTags(r.tags), links: cleanLinks(r.links) }
        if (!x) notes.push({ ...clean, markdown: "", ydoc: null, source: null })
        else if (x.updated < r.updated) Object.assign(x, clean)
        else continue
        ids.push(r.id)
      }
      if (ids.length) changed()
      return later(ids)
    },
    getNotesRelay: async () => later(relay),
    setNotesRelay: async (r: RelayConfig | null) => {
      relay = r
      try {
        if (r) localStorage.setItem("mailbird.demo.relay", JSON.stringify(r))
        else localStorage.removeItem("mailbird.demo.relay")
      } catch {
        // Private windows: the setting lasts this session only.
      }
    },
  }
}

// ── Import (mirrors crates/core/src/notes_import.rs) ───────────────────────

interface Parsed {
  source: string
  markdown: string
  tags: string[]
  pinned: boolean
  archived: boolean
  color: NoteColor | null
  created: number
  updated: number
}

const MEDIA = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "pdf", "m4a", "mp3", "3gp", "awb", "wav", "mp4", "mov"])

function parseImport(files: ImportFile[]): { parsed: Parsed[]; report: ImportReport } {
  const report: ImportReport = { imported: 0, duplicates: 0, trashed: 0, attachmentsDropped: 0, skipped: [] }
  const parsed: Parsed[] = []
  const jsonStems = new Set(files.filter((f) => f.path.endsWith(".json")).map((f) => f.path.slice(0, -5)))
  for (const f of files) {
    const path = f.path.replaceAll("\\", "/")
    const segs = path.split("/")
    if (segs.some((s) => s.startsWith(".") || s === "__MACOSX")) continue
    const name = segs.at(-1) ?? ""
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
    if (name === "Labels.txt" && segs.includes("Keep")) continue
    if (ext === "json") {
      const k = keep(path, f.contents)
      if (k === "trashed") report.trashed++
      else if (!k) report.skipped.push(path)
      else {
        report.attachmentsDropped += k.dropped
        parsed.push(k.note)
      }
    } else if (ext === "md" || ext === "markdown" || ext === "txt") parsed.push(markdownNote(segs, f.contents, f.modified ?? null))
    else if (ext === "html" && jsonStems.has(path.slice(0, -5))) continue
    else if (MEDIA.has(ext)) report.attachmentsDropped++
    else report.skipped.push(path)
  }
  return { parsed, report }
}

function keep(path: string, contents: string): { note: Parsed; dropped: number } | "trashed" | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(contents) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== "object" || !("userEditedTimestampUsec" in o) || !("textContent" in o || "listContent" in o)) return null
  if (o.isTrashed === true) return "trashed"
  const text = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "")
  const secs = (k: string) => (typeof o[k] === "number" ? Math.floor((o[k] as number) / 1_000_000) : 0)
  let md = text("title") ? `# ${text("title")}\n\n` : ""
  const body = text("textContent")
  if (body) md += `${body}\n`
  const list = Array.isArray(o.listContent) ? (o.listContent as { text?: string; isChecked?: boolean }[]) : []
  if (list.length) {
    if (body) md += "\n"
    for (const i of list) md += `- [${i.isChecked ? "x" : " "}] ${(i.text ?? "").replace(/\n/g, " ").trim()}\n`
  }
  const annotations = Array.isArray(o.annotations) ? (o.annotations as { url?: string; title?: string }[]) : []
  const linkLines = annotations.filter((a) => a.url).map((a) => `- [${a.title || a.url}](${a.url})`)
  if (linkLines.length) md += `\n${linkLines.join("\n")}\n`
  const labels = Array.isArray(o.labels) ? (o.labels as { name?: string }[]).map((l) => l.name ?? "").filter(Boolean) : []
  const updated = secs("userEditedTimestampUsec")
  return {
    note: {
      source: `keep:${path}`, markdown: md.trimEnd(), tags: labels, pinned: o.isPinned === true, archived: o.isArchived === true, color: keepColor(o.color),
      created: secs("createdTimestampUsec") || updated, updated,
    },
    dropped: Array.isArray(o.attachments) ? o.attachments.length : 0,
  }
}

function inlineTags(body: string): string[] {
  const tags: string[] = []
  let fenced = false
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const outsideCode = line.replace(/`[^`]*`/g, " ")
    for (const m of outsideCode.matchAll(/(?:^|\s)#([\p{L}\p{N}/_-]+)/gu)) {
      if (/\p{L}/u.test(m[1]!)) tags.push(m[1]!.replace(/\/$/, ""))
    }
  }
  return tags
}

function parseDate(s: string): number | null {
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}${s.length > 10 ? "Z" : "T00:00:00Z"}`)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function markdownNote(segs: string[], raw: string, modified: number | null): Parsed {
  const contents = raw.replace(/\r\n/g, "\n")
  const front = new Map<string, string | string[]>()
  let body = contents
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(contents)
  if (fm) {
    body = contents.slice(fm[0].length)
    let last: string | null = null
    for (const line of fm[1]!.split("\n")) {
      const unq = (s: string) => s.trim().replace(/^["']|["']$/g, "")
      const item = /^\s*- (.*)$/.exec(line)
      if (item && last && Array.isArray(front.get(last))) {
        ;(front.get(last) as string[]).push(unq(item[1]!))
        continue
      }
      const kv = /^([^:]+):(.*)$/.exec(line)
      if (!kv) continue
      last = kv[1]!.trim().toLowerCase()
      const v = kv[2]!.trim()
      front.set(last, !v ? [] : v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1).split(",").map(unq).filter(Boolean) : unq(v))
    }
  }
  const str = (k: string) => (typeof front.get(k) === "string" ? (front.get(k) as string) : null)
  const tags: string[] = segs.length > 2 ? [segs.slice(1, -1).join("/")] : []
  const ft = front.get("tags")
  if (Array.isArray(ft)) tags.push(...ft)
  else if (typeof ft === "string") tags.push(...ft.split(/[, ]/).filter(Boolean))
  tags.push(...inlineTags(body))
  const stem = (segs.at(-1) ?? "").replace(/\.[^.]+$/, "")
  const title = str("title") || stem
  body = body.trim()
  const first = titleAndSnippet(body)[0]
  const heading = /^#+ /.test(body)
  const markdown = !title || heading || first.toLowerCase() === title.toLowerCase() ? body : `# ${title}\n\n${body}`
  const date = (k: string) => (str(k) ? parseDate(str(k)!) : null)
  const updated = date("updated") ?? date("modified") ?? modified ?? 0
  const created = date("created") ?? date("date") ?? updated
  return { source: `md:${segs.join("/")}`, markdown: markdown.trimEnd(), tags, pinned: str("pinned") === "true", archived: false, color: cleanColor(str("color")), created, updated: Math.max(updated, created) }
}
