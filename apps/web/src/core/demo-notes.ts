// In-memory notes for the web demo. Follows crates/core/src/notes_store.rs
// and notes_import.rs where the UI can tell: first-line titles, pinned
// first, word-prefix search over title, text, and tags, tombstones for
// sync, newest-record-wins merges, and the same import formats.

import { downloadNotes } from "@/lib/download"

import type { CoreEvent } from "./client"
import { createDemoFiles, type Media, mediaOf, mimeExt, NOTE_FILE, noteFileIds, sampleSwatches, takeImages } from "./demo-note-files"
import { NOTE_COLORS } from "./types"
import type { ImportFile, ImportReport, NoteDetail, NoteFile, NotesLockInfo, NotesLockSetting, NoteFolder, NoteFolderInput, NoteGraph, NoteInput, NoteLink, NoteMeta, NoteQuery, NoteRecord, NoteColor, NoteShare, NoteSummary, NoteTarget, NoteTask, NotesPrefs, PlannedTask, RelayConfig, ShareMode, TagCount } from "./types"

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

/** A new share's key (ADR-0062), as new_share_key makes them: 32 random bytes, base64url. */
export const demoShareKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

/** A link's key, checked like link_key in note_shares.rs. */
export function demoLinkKey(k: string | null | undefined): string | null {
  const key = k?.trim()
  if (!key) return null
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("that share link isn't complete")
  return key
}

/** A share from someone's link, checked like guest_share in note_shares.rs. */
function guestShare(s: NoteShare): NoteShare {
  const relay = s.relay?.trim()
  const token = s.token?.trim()
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(s.id) || !relay || !/^wss?:\/\//.test(relay) || !token) throw new Error("that share link isn't complete")
  const key = demoLinkKey(s.key)
  return { id: s.id, role: "guest", mode: s.mode === "view" ? "view" : "edit", revoked: false, relay, token, from: s.from?.trim() || null, ...(key ? { key } : {}) }
}

export function createDemoNotes(emit: (e: CoreEvent, payload?: unknown) => void, later: <T>(v: T) => Promise<T>, links: DemoLinks) {
  const t = now()
  const DAY = 86_400
  let n = 0
  const note = (markdown: string, ago: number, extra: Partial<DemoNote> = {}): DemoNote => ({
    id: `note-${++n}`, markdown, ydoc: null, pinned: false, archived: false, deleted: false, color: null, remindAt: null, locked: false, sealed: null, title: null, tags: [], links: [],
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
    note(`Old color experiments\n\nOKLCH ramps with a fixed chroma cap.\n\n![Six hue ramps, light to dark](${NOTE_FILE}demo-swatches)`, 40 * DAY, { archived: true, tags: ["design"] }),
  ]
  let prefs: NotesPrefs = { sortChecked: true, grid: false, readImageText: true }
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
    // A locked note shows its title only (ADR-0043).
    if (x.locked) {
      return {
        id: x.id, title: x.title ?? "", snippet: "", pinned: x.pinned, archived: x.archived, color: x.color ?? null, remindAt: x.remindAt ?? null, locked: true, share: x.share ?? null, tags: [...x.tags],
        links: x.links.map((l) => ({ ...l, target: links.resolve(l) })), created: x.created, updated: x.updated,
      }
    }
    return {
      id: x.id, title, snippet, pinned: x.pinned, archived: x.archived, color: x.color ?? null, remindAt: x.remindAt ?? null, locked: false,
      cover: /\(note-file:([A-Za-z0-9-]+)/.exec(x.markdown)?.[1] ?? null, share: x.share ? { ...x.share } : null, tags: [...x.tags],
      links: x.links.map((l) => ({ ...l, target: links.resolve(l) })), created: x.created, updated: x.updated,
    }
  }
  const detail = (x: DemoNote): NoteDetail => ({ ...summary(x), markdown: x.locked ? "" : x.markdown, ydoc: x.locked ? null : x.ydoc })

  // Locked notes (ADR-0043), as the core does them. The demo's "sealing" is
  // only base64 and its passphrase setting carries the words themselves:
  // there's nothing real to protect here (the core uses AES-256-GCM and
  // PBKDF2), but the flow, the hint, auto-lock, and sync behave the same.
  const AUTO_LOCK = 10 * 60
  let lock: { passphrase: string; hint: string | null; updated: number } | null = null
  let unlockedAt: number | null = null
  // The passphrase the demo's "identity" was last given (ADR-0051): the real
  // app wraps the key under the shared identity on every passphrase unlock.
  let identityHolds: string | null = null
  const lockInfo = (): NotesLockInfo => ({ set: !!lock, hint: lock?.hint ?? null, unlocked: unlockedAt !== null && now() - unlockedAt < AUTO_LOCK, identity: !!lock && identityHolds !== null })
  const requireKey = () => {
    if (!lockInfo().unlocked) {
      unlockedAt = null
      throw new Error("Locked notes are locked. Enter your passphrase to open them.")
    }
    unlockedAt = now()
  }
  const lockedText = new Map<string, string>()
  // Images in notes (ADR-0044); the sample one is drawn when first shown.
  const files = createDemoFiles((id) => notes.some((x) => x.id === id && x.locked), () => lockInfo().unlocked)
  const fileOf = async (id: string) => {
    if (id === "demo-swatches" && !files.records().some((f) => f.id === id)) files.put("note-5", "image/png", await sampleSwatches(), 960, 540, id, t - 40 * DAY)
    return files.get(id)
  }
  const fakeSeal = (md: string) => `demo:${btoa(unescape(encodeURIComponent(md)))}`
  const fakeOpen = (sealed: string | null | undefined) => (sealed?.startsWith("demo:") ? decodeURIComponent(escape(atob(sealed.slice(5)))) : "")
  const textOf = (x: DemoNote) => lockedText.get(x.id) ?? fakeOpen(x.sealed)
  const record = ({ markdown: _m, ydoc: _y, source: _s, ...r }: DemoNote): NoteRecord => structuredClone(r)
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const matches = (x: DemoNote, search: string) => {
    // A locked note is found by its title only, as the core's search does.
    const hay = [...words(x.locked ? (x.title ?? "") : `${x.markdown} ${files.textOf(x.id)}`), ...x.tags.flatMap(words)]
    return words(search).every((w) => hay.some((h) => h.startsWith(w)))
  }
  // Smart folders (ADR-0042), with the core's rules and checks.
  let folders: NoteFolder[] = []
  const inFolder = (x: DemoNote, f: NoteFolderInput) =>
    (!f.tags.length || x.tags.some((t) => f.tags.some((g) => g.toLowerCase() === t.toLowerCase()))) &&
    (!f.words || matches(x, f.words)) &&
    (!f.linked || (f.linked === "any" ? x.links.length > 0 : x.links.some((l) => l.kind === f.linked))) &&
    (!f.color || (f.color === "any" ? !!x.color : x.color === f.color)) &&
    (!f.hasReminder || !!x.remindAt) &&
    (!f.hasOpenTasks || /^\s*[-*+] \[ \]/m.test(x.markdown))
  const folderCount = (f: NoteFolderInput) => notes.filter((x) => !x.deleted && !x.archived && inFolder(x, f)).length
  const checkFolder = (i: NoteFolderInput): NoteFolderInput => {
    const name = i.name.trim()
    if (!name) throw new Error("give the folder a name")
    const tags: string[] = []
    for (const t of i.tags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean)) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t)
    const words = i.words?.trim() || null
    if (!tags.length && !words && !i.linked && !i.color && !i.hasReminder && !i.hasOpenTasks) {
      throw new Error("say which notes belong in it: a tag, some words, a link, a color, or one of the checks")
    }
    return { name, tags, words, linked: i.linked, color: i.color, hasReminder: i.hasReminder, hasOpenTasks: i.hasOpenTasks }
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

  const list = (q: NoteQuery): NoteSummary[] => {
    let linkKey: NoteLink | null = null
    if (q.linked) {
      linkKey = links.linkFor(q.linked)
      if (!linkKey) return []
    }
    const folder = q.folder ? folders.find((f) => f.id === q.folder) : null
    if (q.folder && !folder) throw new Error("that folder was deleted")
    const out = notes
      .filter((x) => !x.deleted && x.archived === !!q.archived)
      .filter((x) => !folder || inFolder(x, folder))
      .filter((x) => !q.search?.trim() || matches(x, q.search))
      .filter((x) => !q.tag || x.tags.some((g) => g.toLowerCase() === q.tag!.toLowerCase()))
      .filter((x) => !linkKey || x.links.some((l) => l.kind === linkKey.kind && l.key === linkKey.key))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated)
      .map(summary)
    return out
  }

  return {
    listNotes: async (q: NoteQuery) => later(list(q)),
    // The map (ADR-0053), as the core builds it: links resolve the way
    // following them would, and show only when both ends are listed.
    noteGraph: async (q: NoteQuery) => {
      const shown = list(q)
      const ids = new Set(shown.map((n) => n.id))
      const byTitle = new Map<string, string>()
      for (const x of notes.filter((x) => !x.deleted).sort((a, b) => b.updated - a.updated)) {
        const t = titleAndSnippet(x.markdown)[0].trim().toLowerCase()
        if (!byTitle.has(t)) byTitle.set(t, x.id)
      }
      const edges: NoteGraph["links"] = []
      const seen = new Set<string>()
      for (const n of shown) {
        const x = find(n.id)
        if (x.locked) continue
        for (const w of wikilinks(x.markdown)) {
          const to = byTitle.get(w.trim().toLowerCase())
          if (!to || to === n.id || !ids.has(to) || seen.has(`${n.id} ${to}`)) continue
          seen.add(`${n.id} ${to}`)
          edges.push({ from: n.id, to })
        }
      }
      const items: NoteGraph["items"] = []
      for (const n of shown) {
        for (const l of n.links) {
          const i = items.find((i) => i.kind === l.kind && i.key === l.key)
          if (!i) items.push({ ...l, notes: [n.id] })
          else if (!i.notes.includes(n.id)) i.notes.push(n.id)
        }
      }
      return later({ notes: shown, links: edges, items })
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
      const docs = notes
        .filter((x) => !x.deleted && !x.locked)
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
      // Images go in attachments/, and the text points there (ADR-0044).
      const out: { path: string; contents: string; dataBase64?: string }[] = []
      for (const f of docs) {
        for (const id of noteFileIds(f.contents)) {
          const img = await fileOf(id).catch(() => null)
          if (!img) continue
          const at = `attachments/${id}.${mimeExt(img.mime)}`
          f.contents = f.contents.replaceAll(`${NOTE_FILE}${id}`, at)
          if (!out.some((o) => o.path === at)) out.push({ path: at, contents: "", dataBase64: img.dataBase64 })
        }
        out.push(f)
      }
      return downloadNotes(out)
    },
    createNote: async (input: NoteInput) => {
      const share = input.share ? guestShare(input.share) : null
      // Random ids, like the core's UUIDs: two devices never mint the same one.
      const x = note(input.markdown, 0, { id: crypto.randomUUID(), pinned: !!input.pinned, tags: cleanTags(input.tags ?? []), links: cleanLinks(input.links ?? []), share, created: now(), updated: now() })
      notes.push(x)
      changed()
      return later(detail(x))
    },
    saveNoteBody: async (id: string, markdown: string, ydoc: string | null, touch: boolean) => {
      const x = notes.find((k) => k.id === id)
      if (!x) throw new Error("that note is gone")
      if (x.locked) throw new Error("that note is locked")
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
    // Shared notes (ADR-0056), as note_shares.rs does them.
    shareNote: async (id: string, mode: ShareMode) => {
      const x = find(id)
      if (x.locked) throw new Error("a locked note can't be shared; remove its lock first")
      if (x.share?.role === "guest") throw new Error("only the person who shared this note can change its link")
      x.share =
        x.share && !x.share.revoked
          ? { ...x.share, mode }
          : { id: crypto.randomUUID().replaceAll("-", ""), role: "owner", mode, revoked: false, relay: null, token: null, from: null, ...(relay?.key ? { key: demoShareKey() } : {}) }
      bump(x)
      changed()
      return later(summary(x))
    },
    unshareNote: async (id: string) => {
      const x = find(id)
      if (x.share?.role === "owner" && !x.share.revoked) x.share = { ...x.share, revoked: true }
      else if (x.share?.role === "guest") x.share = null
      else return later(summary(x))
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
    notesLock: async () => later(lockInfo()),
    setNotesPassphrase: async (passphrase: string, hint: string | null) => {
      if ([...passphrase].length < 6) throw new Error("use at least 6 characters")
      const h = hint?.trim() || null
      if (h?.includes(passphrase)) throw new Error("the hint can't contain the passphrase")
      if (lock && !lockInfo().unlocked) throw new Error("unlock your notes first to change the passphrase")
      lock = { passphrase, hint: h, updated: now() }
      identityHolds = passphrase
      unlockedAt = now()
      changed()
      return later(lockInfo())
    },
    unlockNotes: async (passphrase: string) => {
      if (!lock) throw new Error("set a passphrase for locked notes first")
      if (passphrase !== lock.passphrase) throw new Error("that passphrase isn't right")
      identityHolds = passphrase
      unlockedAt = now()
      return later(lockInfo())
    },
    unlockNotesWithIdentity: async () => {
      if (!lock) throw new Error("set a passphrase for locked notes first")
      if (identityHolds === null) throw new Error("there's no identity on this device yet: unlock with the passphrase once")
      if (identityHolds !== lock.passphrase) throw new Error("your identity doesn't hold the key for these notes: unlock with the passphrase once")
      unlockedAt = now()
      return later(lockInfo())
    },
    lockNotesNow: async () => {
      unlockedAt = null
      changed()
      return later(undefined)
    },
    lockNote: async (id: string) => {
      requireKey()
      const x = find(id)
      if (x.locked) return later(undefined)
      if (x.share && !x.share.revoked) throw new Error("a shared note can't be locked; stop sharing it first")
      lockedText.set(id, x.markdown)
      Object.assign(x, { locked: true, title: titleAndSnippet(x.markdown)[0], sealed: fakeSeal(x.markdown), markdown: "", ydoc: null })
      files.reseal(id, true)
      bump(x)
      changed()
      return later(undefined)
    },
    removeNoteLock: async (id: string) => {
      requireKey()
      const x = find(id)
      Object.assign(x, { locked: false, sealed: null, title: null, markdown: textOf(x) })
      lockedText.delete(id)
      files.reseal(id, false)
      bump(x)
      changed()
      return later(detail(x))
    },
    openLockedNote: async (id: string) => {
      requireKey()
      const x = find(id)
      if (!x.locked) throw new Error("that locked note is gone")
      return later({ ...summary(x), markdown: textOf(x), ydoc: null })
    },
    saveLockedNote: async (id: string, markdown: string, touch: boolean) => {
      requireKey()
      const x = find(id)
      const before = textOf(x)
      lockedText.set(id, markdown)
      x.sealed = fakeSeal(markdown)
      x.title = titleAndSnippet(markdown)[0]
      if (touch && before !== markdown) {
        bump(x)
        changed()
      }
      return later(undefined)
    },
    notesLockSetting: async () => later(lock ? ({ ...lock } as NotesLockSetting) : null),
    applyNotesLockSetting: async (s: NotesLockSetting) => {
      if (lock && lock.updated >= s.updated) return later(false)
      lock = { passphrase: String(s.passphrase), hint: (s.hint as string | null) ?? null, updated: s.updated }
      unlockedAt = null
      changed()
      return later(true)
    },
    addNoteFile: async (noteId: string, mime: string, dataBase64: string, width: number | null, height: number | null) => {
      find(noteId)
      const f = files.add(noteId, mime, dataBase64, width, height)
      changed()
      return later(f)
    },
    noteFile: async (id: string) => later(await fileOf(id)),
    noteFiles: async (noteId: string) => later(files.of(noteId)),
    noteFileRecords: async () => later(files.records()),
    noteFilesGone: async () => later(files.gone()),
    forgetNoteFiles: async (ids: string[]) => {
      if (files.forget(ids)) changed()
      return later(undefined)
    },
    noteFileRaw: async (id: string) => later(files.raw(id)),
    putNoteFile: async (f: NoteFile, raw: string) => {
      const kept = files.apply(f, raw)
      if (kept) changed()
      return later(kept)
    },
    setNoteFileText: async (id: string, text: string) => {
      const f = files.setText(id, text)
      changed()
      return later(f)
    },
    noteFilesWithoutText: async (limit: number) => later(files.withoutText(limit)),
    noteFolders: async () => later(folders.map((f) => ({ ...f, count: folderCount(f) }))),
    saveNoteFolder: async (id: string | null, input: NoteFolderInput) => {
      const rule = checkFolder(input)
      const folder: NoteFolder = { id: id ?? crypto.randomUUID(), ...rule, count: 0 }
      const at = folders.findIndex((f) => f.id === folder.id)
      if (at >= 0) folders[at] = folder
      else if (id) throw new Error("that folder was deleted")
      else folders = [...folders, folder]
      changed()
      return later({ ...folder, count: folderCount(folder) })
    },
    deleteNoteFolder: async (id: string) => {
      folders = folders.filter((f) => f.id !== id)
      changed()
      return later(undefined)
    },
    notesPrefs: async () => later({ ...prefs }),
    setNotesPrefs: async (p: NotesPrefs) => {
      prefs = { ...p }
      changed()
      return later({ ...prefs })
    },
    noteLinkFor: async (target: NoteTarget) => later(links.linkFor(target)),
    importNotes: async (picked: ImportFile[]) => {
      const { parsed, report } = parseImport(picked)
      for (const p of parsed) {
        if (notes.some((x) => x.source === p.source)) {
          report.duplicates++
          continue
        }
        const id = crypto.randomUUID()
        const { images, ...rest } = p
        notes.push(note(p.markdown, 0, { ...rest, id, tags: cleanTags(p.tags) }))
        for (const img of images) files.put(id, img.mime, img.data, null, null, img.id, p.created || now())
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
        const clean = { ...structuredClone(r), color: cleanColor(r.color), remindAt: r.remindAt && r.remindAt > 0 ? r.remindAt : null, tags: cleanTags(r.tags), links: cleanLinks(r.links), share: r.share ?? null }
        if (!x) notes.push({ ...clean, markdown: "", ydoc: null, source: null })
        else if (x.updated < r.updated) Object.assign(x, clean)
        else continue
        // Locked elsewhere: only the sealed text and title stay (ADR-0043).
        if (clean.locked) {
          const y = notes.find((k) => k.id === r.id)!
          Object.assign(y, { markdown: "", ydoc: null })
          lockedText.delete(r.id)
        }
        ids.push(r.id)
      }
      if (ids.length) changed()
      return later(ids)
    },
    getNotesRelay: async () => later(relay),
    /** Not the client's: whether new links get keys, for the demo's shared conversations. */
    relaySealed: () => !!relay?.key,
    setNotesRelay: async (r: RelayConfig | null) => {
      if (r?.key && !/^[A-Za-z0-9_-]{43}$/.test(r.key.trim())) throw new Error("That encryption key isn't complete. Copy it again from a device that has it.")
      relay = r && { ...r, key: r.key?.trim() || null }
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
  images: { id: string; mime: string; data: string }[]
}

const MEDIA = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "pdf", "m4a", "mp3", "3gp", "awb", "wav", "mp4", "mov"])

function parseImport(files: ImportFile[]): { parsed: Parsed[]; report: ImportReport } {
  const report: ImportReport = { imported: 0, duplicates: 0, trashed: 0, attachmentsDropped: 0, skipped: [] }
  const parsed: Parsed[] = []
  const jsonStems = new Set(files.filter((f) => f.path.endsWith(".json")).map((f) => f.path.slice(0, -5)))
  const media = mediaOf(files)
  for (const f of files) {
    const path = f.path.replaceAll("\\", "/")
    const segs = path.split("/")
    if (segs.some((s) => s.startsWith(".") || s === "__MACOSX")) continue
    const name = segs.at(-1) ?? ""
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
    if (name === "Labels.txt" && segs.includes("Keep")) continue
    if (ext === "json") {
      const k = keep(path, f.contents, media)
      if (k === "trashed") report.trashed++
      else if (!k) report.skipped.push(path)
      else {
        report.attachmentsDropped += k.dropped
        parsed.push(k.note)
      }
    } else if (ext === "md" || ext === "markdown" || ext === "txt") {
      const { note, missing } = markdownNote(segs, f.contents, f.modified ?? null, media)
      report.attachmentsDropped += missing
      parsed.push(note)
    } else if (ext === "html" && jsonStems.has(path.slice(0, -5))) continue
    // Images come in with the notes that show them (ADR-0044).
    else if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) continue
    else if (MEDIA.has(ext)) report.attachmentsDropped++
    else report.skipped.push(path)
  }
  return { parsed, report }
}

function keep(path: string, contents: string, media: Media): { note: Parsed; dropped: number } | "trashed" | null {
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
  const dir = path.split("/").slice(0, -1).join("/")
  const images: Parsed["images"] = []
  let dropped = 0
  for (const a of Array.isArray(o.attachments) ? (o.attachments as { filePath?: string }[]) : []) {
    const img = a.filePath ? media.take(dir, a.filePath) : null
    if (!img) dropped++
    else {
      md += `\n![](${NOTE_FILE}${img.id})\n`
      images.push(img)
    }
  }
  return {
    note: {
      source: `keep:${path}`, markdown: md.trimEnd(), tags: labels, pinned: o.isPinned === true, archived: o.isArchived === true, color: keepColor(o.color),
      created: secs("createdTimestampUsec") || updated, updated, images,
    },
    dropped,
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

function markdownNote(segs: string[], raw: string, modified: number | null, media: Media): { note: Parsed; missing: number } {
  const taken = takeImages(raw.replace(/\r\n/g, "\n"), segs.slice(0, -1).join("/"), media)
  const contents = taken.markdown
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
  return {
    note: { source: `md:${segs.join("/")}`, markdown: markdown.trimEnd(), tags, pinned: str("pinned") === "true", archived: false, color: cleanColor(str("color")), created, updated: Math.max(updated, created), images: taken.images },
    missing: taken.missing,
  }
}
