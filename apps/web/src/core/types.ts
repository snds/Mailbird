// Mirrors crates/core/src/model.rs and capabilities.rs (serde camelCase).
// Keep the two in step by hand; the Rust side is the source of truth.

export type Provider = "google" | "microsoft" | "i_cloud" | "jmap" | "generic" | "local"
export type Security = "tls" | "start_tls" | "plain"
/** `waiting`: mail you sent, with a follow-up reminder not yet due. */
export type Lane = "inbox" | "unread" | "starred" | "snoozed" | "archive" | "waiting" | "screener"

/** What kind of mail: from the headers, unless you moved the sender (ADR-0018). */
export type Category = "people" | "updates" | "newsletters"

/** `screened_out`: their mail skips the inbox. `blocked`: and is marked read. */
export type SenderDecision = "allowed" | "screened_out" | "blocked"

export interface Sender {
  email: string
  name: string | null
  decision: SenderDecision | null
  category: Category | null
  messages: number
}

export interface ScreenerStatus {
  enabled: boolean
  since: number | null
  /** Senders waiting for a yes or no. */
  waiting: number
}
export type OutboxState = "queued" | "sending" | "sent" | "failed" | "cancelled"

export interface Capabilities {
  mail: boolean
  calendar: boolean
  contacts: boolean
  notes: "native" | "import_only" | "unsupported"
  mail_organization: "labels" | "folders" | null
  contact_groups: boolean
  server_side_scheduling: boolean
  push: boolean
  auth: "o_auth2" | "app_password" | "password" | "none"
}

export interface ServerConfig {
  host: string
  port: number
  security: Security
}

export interface JmapConfig {
  /** The session resource, e.g. https://api.fastmail.com/jmap/session */
  sessionUrl: string
  /** Send the secret as an API token (Bearer) instead of username + password. */
  bearer: boolean
}

export interface AccountConfig {
  displayName: string
  address: string
  username: string
  provider: Provider
  /** Used when `jmap` is absent. */
  imap: ServerConfig
  smtp: ServerConfig
  /** When set, mail syncs and sends over JMAP instead of IMAP/SMTP. */
  jmap?: JmapConfig | null
  /** Calendars and contacts over CalDAV/CardDAV. */
  dav?: DavConfig | null
  /** Signed in with the provider in the browser (Google), not a password. */
  oauth?: OAuthAccount | null
}

export type PushMode = "periodic" | "relay"

/** What the push relay reports for one watched mailbox. */
export interface PushWatchStatus {
  kind: string
  lastChange: number | null
  lastPush: number | null
  error: string | null
}

export interface PushAccount {
  accountId: string
  address: string
  via: "relay" | "periodic"
  /** Why an account stays on the phone's schedule (Gmail). */
  note: string | null
  status: PushWatchStatus | null
}

/** How new mail reaches this device when the app isn't open (ADR-0015). */
export interface PushSettings {
  mode: PushMode
  relayUrl: string | null
  target: "apns" | "fcm" | "unifiedpush" | null
  unifiedPushEndpoint: string | null
  /** The phone reported its own push service (APNs or FCM). */
  platformPush: boolean
  accounts: PushAccount[]
  /** Why the relay couldn't be reached just now. */
  error: string | null
}

export interface PushSettingsInput {
  mode: PushMode
  relayUrl?: string | null
  /** Left out to keep the saved token. */
  relayToken?: string | null
  unifiedPushEndpoint?: string | null
}

export type OAuthIssuer = "google" | "microsoft"

export interface OAuthAccount {
  issuer: OAuthIssuer
  clientId: string
}

/** The app's registration with a provider (an OAuth client). */
export interface OAuthClientInfo {
  clientId: string
  hasSecret: boolean
  /** Baked into this build, rather than set in the app. */
  builtIn: boolean
}

export interface DavConfig {
  /** CalDAV entry point: a server root (well-known discovery) or a known path. */
  calendarUrl?: string | null
  contactsUrl?: string | null
  /** DAV signs in with its own app password (Fastmail). */
  separateSecret?: boolean
}

export interface Account extends AccountConfig {
  id: string
  lastSync: number | null
  lastError: string | null
  /** Calendar/contacts sync is tracked apart from mail. */
  davLastSync: number | null
  davError: string | null
}

export interface Address {
  name: string | null
  email: string
}

export interface MessageQuery {
  lane: Lane
  accountId?: string | null
  search?: string | null
  limit?: number | null
  /** Rows to skip, for paging through a long list. */
  offset?: number | null
  /** Only People, Updates, or Newsletters. */
  category?: Category | null
  /** Inbox only: just the mail this split catches. */
  split?: string | null
  /** Inbox only: fold newsletters into the bundle when there are two or more. */
  bundle?: boolean
}

/** Your own inbox tab: mail matching every field set. */
export interface SplitInput {
  name: string
  /** Addresses, or whole domains like "@studio.example". */
  senders: string[]
  /** Words the subject contains. */
  subject?: string | null
  hasAttachments?: boolean
  accountId?: string | null
  /** Its mail leaves the main inbox. */
  exclusive: boolean
}

export interface Split extends SplitInput {
  id: string
}

export interface SplitCount {
  id: string
  threads: number
  unread: number
}

export interface NewsletterBundle {
  threads: number
  unread: number
  latest: number
  /** Up to three, newest first. */
  senders: string[]
}

export interface InboxOverview {
  splits: SplitCount[]
  bundle: NewsletterBundle | null
}

/** A list row is a conversation: its newest matching message plus thread totals. */
export interface MessageSummary {
  id: string
  accountId: string
  threadId: string
  /** Messages in the whole conversation, including your sent replies. */
  threadCount: number
  hasAttachments: boolean
  from: Address
  subject: string
  preview: string
  /** Seconds since the epoch. */
  date: number
  sortAt: number
  /** In a list row: every message in the thread is read. */
  seen: boolean
  /** In a list row: some message in the thread is starred. */
  flagged: boolean
  archived: boolean
  snoozedUntil: number | null
  /** "INBOX", or "Sent" for copies of mail sent from this device. */
  mailbox: string
  /** On sent mail: when the follow-up reminder is due. Past means it came back. */
  followUpAt?: number | null
  /** On sent mail: the first recipient's name or address. */
  sentTo?: string | null
  category?: Category
}

export interface AttachmentInfo {
  id: string
  filename: string
  mimeType: string
  size: number
  /** Embedded in the body (cid: image), not shown as a file. */
  inline: boolean
}

export interface MessageDetail extends MessageSummary {
  to: Address[]
  cc: Address[]
  messageId: string | null
  bodyText: string
  /** Untrusted. Only ever rendered inside a sandboxed iframe. */
  bodyHtml: string | null
  attachments: AttachmentInfo[]
  /** References + In-Reply-To, oldest first; a reply appends this message's id. */
  references: string[]
  invite?: Invite | null
  /** From the List-Unsubscribe headers (RFC 2369, RFC 8058). */
  unsubscribe?: Unsubscribe | null
}

export interface Unsubscribe {
  /** Unsubscribes with one request, no page to visit. */
  oneClick: string | null
  mailto: string | null
  web: string | null
}

export type UnsubscribeMethod = "one_click" | "mail" | "web"

export interface Template {
  id: string
  name: string
  /** Fills the subject when it's empty. */
  subject: string
  html: string
  updated: number
}

export interface TemplateInput {
  id?: string | null
  name: string
  subject: string
  html: string
}

export interface Signature {
  accountId: string
  html: string
}

export interface OutgoingAttachment {
  filename: string
  mimeType: string
  dataBase64: string
}

export interface Draft {
  accountId: string
  to: Address[]
  cc: Address[]
  subject: string
  /** Plain-text part; always sent. */
  body: string
  /** Rich part from the composer, sent alongside `body` as multipart/alternative. */
  bodyHtml?: string | null
  inReplyTo?: string | null
  references?: string[]
  attachments?: OutgoingAttachment[]
  /** Bring the conversation back this many seconds after sending, if nobody replies. */
  followUpAfter?: number | null
}

export interface OutboxItem {
  id: string
  draft: Draft
  sendAt: number
  state: OutboxState
  error: string | null
  /** Sent later on purpose, not just waiting out the undo window. */
  scheduled?: boolean
}

// ── Calendars and contacts ───────────────────────────────────────────────

export type CollectionKind = "calendar" | "contacts"

export interface Collection {
  id: string
  /** null: lives only on this device. */
  accountId: string | null
  kind: CollectionKind
  name: string
  color: string | null
  writable: boolean
  hidden: boolean
  /** The server sends invitations and replies itself (CalDAV scheduling). */
  scheduling: boolean
}

/** "custom" is a richer rule from another app; edits keep it unchanged. */
export type Repeat = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom"

/** Wall-clock times in `timeZone` ("2026-10-14T09:30"); all-day uses dates with an exclusive end. */
export interface EventInput {
  calendarId: string
  title: string
  location?: string | null
  notes?: string | null
  start: string
  end: string
  allDay: boolean
  timeZone: string
  repeat: Repeat
  /** Minutes before the start (0 = at the start). Omit to keep them as they are. */
  reminders?: number[] | null
  /** Guests to invite. Omit to keep the guest list; [] removes it. */
  attendees?: Address[] | null
  /** Minutes to get there. Omit to keep it; 0 removes it. */
  travel?: number | null
}

/** Which occurrences of a series an edit or delete applies to. */
export type EditScope = "all" | "this" | "following"

/** One occurrence. Seconds since the epoch; all-day ones start at local midnight. */
export interface Occurrence {
  eventId: string
  calendarId: string
  title: string
  location: string | null
  start: number
  end: number
  /** The occurrence's slot in its series; edits of one occurrence address it by this. */
  originalStart: number
  allDay: boolean
  recurring: boolean
  /** The video-call link (Zoom, Meet, Teams …) in the location; the event view also looks in the notes and URL. */
  meetingUrl?: string | null
  /** Set on the Birthdays calendar: the contact whose birthday this is. */
  contactId?: string | null
  /** Minutes to get there, blocked out before `start` (ADR-0029). */
  travel?: number | null
  /** `meetingUrl` in its service's app (Zoom, Teams), when it has one (ADR-0030). */
  meetingAppUrl?: string | null
}

/** What an invitation says about its call (ADR-0030). */
export interface MeetingInfo {
  /** "zoom", "meet", "teams", "webex", "jitsi", "whereby", "facetime", "goto", "chime". */
  service: string
  url: string
  appUrl: string | null
  meetingId: string | null
  passcode: string | null
  dialIn: DialIn[]
}

export interface DialIn {
  number: string
  label: string | null
  /** Dials the number, then the meeting ID and PIN. */
  tel: string
}

/** A booking tool's link to change the booking (Calendly, Cal.com …). */
export interface ManageLink {
  /** "reschedule", "cancel", or "manage". */
  action: string
  tool: string
  url: string
}

export interface MeetingPrefs {
  /** Open calls in Zoom's or Teams' app when there's a link for it. */
  openInApps: boolean
}

export interface Attendee {
  name: string | null
  email: string
  /** "accepted" | "declined" | "tentative" | "needs-action" … */
  status: string | null
}

export interface EventDetail extends Occurrence {
  notes: string | null
  repeat: Repeat
  timeZone: string | null
  organizer: Address | null
  attendees: Attendee[]
  url: string | null
  writable: boolean
  /** Minutes before the start. */
  reminders: number[]
  meeting?: MeetingInfo | null
  manage?: ManageLink[]
}

export interface DueReminder {
  eventId: string
  title: string
  location: string | null
  start: number
  fireAt: number
  /** "Time to leave": its travel time begins now (ADR-0029). */
  leave?: boolean
}

/** What you have going on with one contact. */
export interface ContactActivity {
  /** Newest first, one row per conversation. */
  threads: MessageSummary[]
  /** Soonest first. */
  upcoming: Occurrence[]
  /** Most recent first. */
  past: Occurrence[]
}

export type InviteResponse = "accepted" | "tentative" | "declined"

/** The invitation, cancellation, or guest reply a message carries. */
export interface Invite {
  method: "request" | "cancel" | "reply" | string
  uid: string
  title: string
  location: string | null
  start: number | null
  end: number | null
  allDay: boolean
  recurring: boolean
  organizer: Address | null
  attendees: Attendee[]
  /** Your answer, from your calendar's copy when there is one. */
  myStatus: string | null
  /** Your calendar's copy of the event. */
  eventId: string | null
  /** Your calendar already has a newer version. */
  outdated: boolean
  /** For a reply: the guest and their answer. For a counter-proposal: who proposed. */
  from: Attendee | null
  /** Events in your calendars at the same time (invitations and counter-proposals). */
  conflicts?: Occurrence[]
  /** For a counter-proposal: your event's time now. */
  currentStart?: number | null
  currentEnd?: number | null
  /** The guest's note on a reply or counter-proposal. */
  comment?: string | null
  /** For a counter-proposal you've answered. */
  answered?: "accepted" | "declined" | null
  /** For an invitation: the new time you proposed. */
  proposed?: TimeSlot | null
  /** The call the invitation is for, and its booking tool's links (ADR-0030). */
  meeting?: MeetingInfo | null
  manage?: ManageLink[]
}

/** A free stretch of time, from "find a time". */
export interface TimeSlot {
  start: number
  end: number
}

/** A saved set of visible calendars. */
export interface CalendarSet {
  id: string
  name: string
  calendarIds: string[]
}

export interface FindTimes {
  from: number
  minutes: number
  /** Minutes after local midnight. */
  dayStart: number
  dayEnd: number
  weekdaysOnly: boolean
  limit?: number
}

export interface ContactField {
  /** vCard TYPE: "work", "home", "cell"… */
  label: string | null
  value: string
}

export interface ContactInput {
  bookId: string
  fullName: string
  emails: ContactField[]
  phones: ContactField[]
  org?: string | null
  title?: string | null
  note?: string | null
  /** "YYYY-MM-DD", or "--MM-DD" without a year. */
  birthday?: string | null
  /** Labels (vCard CATEGORIES). Leave out to keep the card's labels as they are. */
  labels?: string[] | null
  /** A `data:image/…;base64` photo. Leave out to keep it; "" removes it. */
  photo?: string | null
}

/** The same person's card in another address book (ADR-0027). */
export interface ContactCopy {
  id: string
  bookId: string
  fullName: string
}

export interface ContactSummary {
  id: string
  bookId: string
  fullName: string
  org: string | null
  emails: ContactField[]
  phones: ContactField[]
  /** data: URL; remote photos are never fetched. */
  photo: string | null
  labels: string[]
}

export interface ContactDetail extends ContactSummary {
  title: string | null
  note: string | null
  birthday: string | null
  writable: boolean
}

export interface ContactLabel {
  name: string
  count: number
}

/** What a scheduling link offers (ADR-0026). */
export interface BookingLinkInput {
  title: string
  minutes: number
  /** Where booked events go. */
  calendarId: string
  /** Minutes after midnight, the calendar's time zone. */
  dayStart: number
  dayEnd: number
  weekdaysOnly: boolean
  /** 1–14. */
  daysAhead: number
  note: string | null
}

export interface BookingLink extends BookingLinkInput {
  id: string
  /** The unguessable part of the page's address. */
  token: string
  bookedAt: number[]
}

/** What the public page shows: free times, nothing else about your calendar. */
export interface PublicBooking {
  title: string
  minutes: number
  host: string
  timeZone: string
  note: string | null
  slots: TimeSlot[]
}

export interface BookingRequest {
  start: number
  name: string
  email: string
  note: string | null
}

export interface Booked {
  start: number
  end: number
  title: string
  host: string
  /** An invitation was emailed to the booker. */
  invited: boolean
  /** The private code for this booking's own page: change the time or cancel (ADR-0031). */
  code: string
}

/** A booking's own page: the booking, and the times it can move to. */
export interface ManagedBooking {
  title: string
  host: string
  name: string
  start: number
  end: number
  minutes: number
  timeZone: string
  cancelled: boolean
  past: boolean
  slots: TimeSlot[]
  movesLeft: number
}

export type BookingChange = { action: "reschedule"; start: number } | { action: "cancel" }

/** A mail action a swipe can do (ADR-0025). */
export type SwipeActionId = "none" | "read" | "archive" | "star" | "snooze-tomorrow" | "snooze-next-week" | "remind" | "newsletters"

/** Your swipes, short and long, each way. A long swipe of "none" does the short one's action. */
export interface SwipeActions {
  right: SwipeActionId
  rightLong: SwipeActionId
  left: SwipeActionId
  leftLong: SwipeActionId
}

/** A holiday or moon-phase calendar you can add (ADR-0024). */
export interface InterestingCalendar {
  id: string
  name: string
  group: "holidays" | "sky"
  /** ISO country code, for holidays. */
  country: string | null
  subscribed: boolean
}

/** What a smart group matches; every filled-in rule must hold (ADR-0023). */
export interface SmartGroupInput {
  name: string
  /** Has any of these labels. */
  labels: string[]
  /** Company contains these words. */
  company: string | null
  /** An email at this domain or its subdomains. */
  domain: string | null
  hasPhone: boolean
  hasBirthday: boolean
  /** Mail either way in the last this-many days. */
  inTouchDays: number | null
}

export interface SmartGroup extends SmartGroupInput {
  id: string
  /** Members right now. */
  count: number
}

/** What restoring contacts to a point in time would change, by name. */
export interface ContactsRestore {
  /** Added since: removed, to Recently deleted. */
  added: string[]
  /** Edited since: put back how they were. */
  edited: string[]
  /** Deleted since: brought back. */
  deleted: string[]
  /** Changes in read-only address books, left alone. */
  readOnly: number
}

export interface ContactsRestored {
  changed: number
  /** Restoring with `after: mark` undoes this restore. */
  mark: number
}

/** A contact in Recently deleted (kept 30 days). */
export interface DeletedContact {
  id: string
  bookId: string
  fullName: string
  emails: ContactField[]
  deletedAt: number
}

/** A card read from an email signature; empty fields weren't found. */
export interface SignatureCard {
  fullName: string
  org: string | null
  title: string | null
  emails: ContactField[]
  phones: ContactField[]
}

/** What a message's signature adds: a new contact, or details yours lacks. */
export interface ContactSuggestion {
  /** The contact it would update; null means a new one. */
  contactId: string | null
  /** For the editor: the signature, merged under your own fields. */
  card: SignatureCard
  /** "contact", "phone", "title", "company", "email" */
  adds: string[]
}

export interface ContactExport {
  fileName: string
  vcf: string
}

// ── Notes ───────────────────────────────────────────────────────────────────

/** Links use keys every device shares: an event's or contact's UID, a conversation's first Message-ID. */
export type NoteLinkKind = "event" | "contact" | "thread"

export interface NoteLink {
  kind: NoteLinkKind
  key: string
  /** Shown when the target isn't on this device. */
  label: string
  /** The target's id here, when it's here. */
  target?: string | null
}

/** How checklists behave in notes (ADR-0028). */
export interface NotesPrefs {
  /** Checking an item moves it below the unchecked ones. */
  sortChecked: boolean
}

/** A checklist item in a note (ADR-0028). */
export interface NoteTask {
  noteId: string
  noteTitle: string
  /** Its place among the note's checklist items, from 0, in document order. */
  index: number
  text: string
  done: boolean
  /** The calendar block it was planned as, if any. */
  planned: PlannedTask | null
}

export interface PlannedTask {
  eventId: string
  start: number
  end: number | null
}

export interface NoteSummary {
  id: string
  /** The first line, without Markdown marks. */
  title: string
  snippet: string
  pinned: boolean
  archived: boolean
  tags: string[]
  links: NoteLink[]
  created: number
  updated: number
}

export interface NoteDetail extends NoteSummary {
  markdown: string
  /** base64 Yjs state, once an editor has opened the note. */
  ydoc: string | null
}

export interface NoteInput {
  markdown: string
  pinned?: boolean
  tags?: string[]
  links?: NoteLink[]
}

/** Omitted fields stay as they are. */
export interface NoteMeta {
  pinned?: boolean
  archived?: boolean
  tags?: string[]
  links?: NoteLink[]
}

export interface NoteTarget {
  kind: NoteLinkKind
  id: string
}

export interface NoteQuery {
  search?: string | null
  tag?: string | null
  archived?: boolean
  linked?: NoteTarget | null
}

export interface TagCount {
  tag: string
  count: number
}

export interface ImportFile {
  /** Path inside the picked folder; folders become tags. */
  path: string
  contents: string
  modified?: number | null
}

export interface ImportReport {
  imported: number
  duplicates: number
  trashed: number
  attachmentsDropped: number
  skipped: string[]
}

/** Everything but a note's text, which syncs as its own Yjs document. Newest `updated` wins. */
export interface NoteRecord {
  id: string
  pinned: boolean
  archived: boolean
  deleted: boolean
  tags: string[]
  links: NoteLink[]
  created: number
  updated: number
}

export interface RelayConfig {
  /** wss://… (ws:// only on this device). */
  url: string
  token: string
}
