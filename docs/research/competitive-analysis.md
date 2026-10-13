# Competitive and protocol research

_Researched 2026-10-13. Pricing figures from third-party aggregators conflict with each other; recheck on vendor sites before external use._

## 1. Market gap

Only three vendors bundle mail, calendar, contacts, and notes/tasks across Windows, macOS, iOS, Android, and web, and each one has a catch.

- **Microsoft Outlook** comes closest. It is ad-supported for free users ([Microsoft](https://support.microsoft.com/en-US/Outlook/ads-in-outlook-mobile)). Notes live in separate apps (To Do, OneNote, and Sticky Notes). New Outlook for Windows still trails classic Outlook on features.
- **Google** covers every platform, but through four separate apps. Gmail shows ads in its Promotions and Social tabs. Keep has no desktop app, and its API is Workspace-only ([Google](https://developers.google.com/workspace/keep)).
- **Zoho** (Mail, Calendar, Contacts, and Notebook) covers the platforms. Its UX is business-oriented and the brand is little known to consumers.

Everyone else has a platform hole:

- Apple has no Android or Windows apps, only iCloud.com.
- Fantastical is not on Android, and Cardhop is Apple-only ([TechCrunch](https://techcrunch.com/2024/10/29/popular-calendar-app-fantastical-lands-on-windows/)).
- Mimestream is Mac-only and Gmail-only ([FAQ](https://mimestream.com/faqs)).
- Mailbird is desktop-only.
- Proton, Tuta, Fastmail, and HEY lock you into their own mail host.
- Spark and Superhuman are mail-first and have moved to premium pricing.
- Notion Mail shut down on 2026-09-22 ([Notion](https://www.notion.com/help/notion-mail-inbox-is-going-away-what-to-do-next)).
- Thunderbird is the open-source contender. Desktop is mature, Android is K-9-based, iOS is unreleased, and Thundermail is in waitlist or beta ([Thunderbird blog](https://blog.thunderbird.net/2026/04/thunderbird-pro-april-2026-update/)).

**The gap:** no open-source, provider-agnostic, ad-free app combines all four verticals with a modern, mobile-first UX on all six platforms.

> **Naming risk.** Mailbird is an active commercial product (Mailbird, Inc.). It ships on Windows 10/11 and on macOS through the Mac App Store. It has no mobile apps, and it is freemium, with Premium at about $34.49/yr or $159 one-time ([Mailbird for Mac](https://www.getmailbird.com/mailbird-for-mac), [press kit, Sept 2026](https://www.getmailbird.com/assets/press/mailbird-press-kit-september-2026.pdf)). This repo's name collides with a live trademark in the same category. Rename before any public release. See [ADR-0006](../decisions/0006-product-name.md).

## 2. Platform coverage matrix

✓ = native app · W = web only or wrapper · P = partial or beta · — = none

| Product | Win | Mac | iOS | iPadOS | Android | Web | Linux | Mail | Cal | Contacts | Notes/Tasks | License / price | Ads? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple Mail/Cal/Contacts/Notes | W | ✓ | ✓ | ✓ | W | ✓ (iCloud.com) | W | ✓ | ✓ | ✓ | ✓ / Reminders | Free, closed | No |
| Google Gmail/Cal/Contacts/Keep | W | W | ✓ | ✓ | ✓ | ✓ | W | ✓ | ✓ | ✓ | ✓ Keep / Tasks | Free + Workspace, closed | Yes (Gmail tabs) |
| Microsoft Outlook (new/mobile/web) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | W | ✓ | ✓ | ✓ | P (To Do, OneNote) | Free + M365, closed | Yes, free tier |
| Thunderbird (desktop/Android/iOS) | ✓ | ✓ | P (unreleased) | P | ✓ (ex-K-9) | — | ✓ | ✓ | ✓ desktop | ✓ desktop | P tasks | MPL, free; Pro paid | No |
| Spark (Readdle) | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | P | — | — | Free / Plus / Pro | No |
| Superhuman Mail | — | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | P | — | — | ~$30/mo, closed | No |
| HEY | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (own host) | ✓ | P | P | $99/yr | No |
| Fastmail | — | W | ✓ | ✓ | ✓ | ✓ | — | ✓ (own host) | ✓ | ✓ | ✓ notes | Paid | No |
| Proton Mail/Calendar | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | P (beta) | ✓ (own host) | ✓ | ✓ | — | Freemium; OSS clients | No |
| Tuta | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (own host) | ✓ | ✓ | — | Freemium; GPL clients | No |
| Notion Calendar (Mail closed 9/2026) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✗ | ✓ | — | via Notion | Free, closed | No |
| Fantastical + Cardhop | ✓ (Fantastical) | ✓ | ✓ | ✓ | — | — | — | — | ✓ | ✓ (Apple) | ✓ tasks | ~$57/yr, closed | No |
| Mimestream | — | ✓ | P | P | — | — | — | ✓ (Gmail) | — | — | — | $49.99/yr | No |
| Canary Mail | ✓ | ✓ | ✓ | ✓ | ✓ | P | — | ✓ | P | — | — | Freemium | No |
| eM Client | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | ✓ tasks/notes | €39.95/yr or one-time | No |
| Mailbird | ✓ | ✓ | — | — | — | — | — | ✓ | via apps | ✓ | — | Freemium, closed | No |
| Morgen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | ✓ tasks | ~$15/mo | No |
| Bear | — | ✓ | ✓ | ✓ | — | P | — | — | — | — | ✓ | ~$30/yr | No |
| Obsidian | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | — | ✓ | Free; Sync paid; closed | No |
| Zoho Mail suite | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ Notebook | Freemium | No |
| Mailspring | ✓ | ✓ | — | — | — | — | ✓ | ✓ | P | ✓ | — | GPL + Pro | No |
| FairEmail | — | — | — | — | ✓ | — | — | ✓ | — | P | — | GPL + Pro | No |
| Nextcloud apps | W | W | P | P | P | ✓ | W | ✓ | ✓ | ✓ | ✓ | AGPL, self-host | No |

**Closest direct competitor:** eM Client. It is the only closed product with all four verticals plus mobile, but it has no web or Linux build and a dated desktop-first UX.

## 3. Best-of feature harvest

### Mail

| Feature | Best at it | Why it works |
|---|---|---|
| Unified inbox | Apple Mail, Spark | One triage surface for many accounts cuts out context switching. |
| Smart inbox (People / Notifications / Newsletters) | Spark | Sorting by sender type matches how people actually prioritize. |
| Split inbox (user-defined) | Superhuman | Users build their own lanes, so the inbox matches their job. |
| Screener for first-time senders | HEY | New senders ask permission, which removes spam anxiety. |
| Imbox / Feed / Paper Trail | HEY | Important mail, reading material, and receipts each get their own reading posture. |
| Snooze | Gmail, Spark | Turns the inbox into a to-do list ordered by time. |
| Send later | Gmail, Outlook | Respects the recipient's time zone and the sender's working hours. |
| Undo send (configurable delay) | Gmail | Cheap insurance against the "oh no" moment. |
| Follow-up reminders | Superhuman, Gmail Nudges | Moves the job of remembering from the user's head to the system. |
| Command palette (⌘K) and keyboard grammar | Superhuman | Features are easy to find, and experts work fast without UI clutter. |
| Configurable swipe gestures | Spark, Outlook mobile | One-thumb triage that respects different mental models. |
| Bundles and grouped newsletters | Inbox by Google (legacy), Gmail tabs | Collapsing low-value volume shrinks perceived inbox size. |
| Tracker and pixel blocking | Apple Mail, HEY | Privacy by default builds trust and is invisible until needed. |
| One-tap unsubscribe and block | Gmail, Apple Mail | Treats the cause of overload, not the symptoms. |
| Shared drafts and team comments | Spark Teams | Collaboration happens in the thread instead of in forwarding chains. |
| Deep power settings | FairEmail | Open-source users value control. Hide it behind progressive disclosure. |
| AI summaries and smart reply (opt-in) | Gmail, Spark +AI | Shortens long threads. It must stay optional and private. |
| Templates and snippets | Superhuman, Spark | Reuses repetitive writing through text expansion. |

### Calendar

| Feature | Best at it | Why it works |
|---|---|---|
| Natural-language event entry | Fantastical | Quick input with a live parse preview that confirms what you typed. |
| Scheduling links / booking pages | Google, Morgen, Thunderbird Appointment | Ends back-and-forth email about times. |
| Multiple time zones in the gutter | Notion Calendar | Distributed teams see overlap at a glance. |
| Time-zone-aware event creation | Fantastical | Prevents off-by-hours errors when traveling. |
| Travel time and leave-now alerts | Apple Calendar | Blocks reflect real-world logistics. |
| Availability overlay | Outlook Scheduling Assistant, Notion Calendar | Shows free and busy before you propose a time. |
| Calendar sets (work/personal) | Fantastical | One tap switches context and cuts visual noise. |
| Unified calendar across providers | Morgen, Fantastical | One view of Google, iCloud, and Exchange. |
| Tasks time-blocked on the calendar | Morgen | Turns intentions into committed time. |
| Join-meeting button | Notion Calendar, Fantastical | No hunting for the link at 9:59. |
| Propose new time / RSVP with note | Outlook | Negotiation stays inside the invite. |
| Widget / menu-bar mini-calendar | Fantastical, Notion Calendar | Answers "what's next" without opening the app. |
| Interesting calendars (holidays, sports) | Fantastical, Google | Useful context with zero setup. |
| Keyboard navigation | Notion Calendar | Desktop power users never touch the mouse. |
| Invite in thread shows conflicts | Outlook, HEY | Decide on an invite without leaving mail. |

### Contacts

| Feature | Best at it | Why it works |
|---|---|---|
| Natural-language entry and signature parsing | Cardhop | Pasting a signature creates a contact, so data entry stops being a chore. |
| Duplicate detection and merge | Google Contacts | Ongoing hygiene through suggestions instead of forced merges. |
| Enrichment from email signatures | Google, Cardhop | Contacts stay current with no manual effort. |
| Smart groups (rule-based) | Apple Contacts | Lists maintain themselves. |
| Labels and multi-group membership | Google Contacts | Tags model reality better than folders. |
| Quick actions (call, mail, message, video) | Cardhop | A contact becomes a launcher, not just a record. |
| Interaction history (mail, meetings, notes) | Outlook People | Relationship context before replying or meeting. |
| Birthdays feeding the calendar | Apple, Google | Cross-vertical value from data you already have. |
| Contact photos / posters | Apple (iOS 17+) | Fast visual recognition in lists. |
| Unified contacts with source badges | Apple Contacts | Shows where each record lives, so you don't edit the wrong copy. |
| Restore to a point in time | Google Contacts | A safety net for bulk edits and sync accidents. |
| vCard and QR sharing | Apple, Cardhop | Low-friction exchange in person. |
| Sender profile in the mail pane | Superhuman | Context right where you decide. |

### Notes

| Feature | Best at it | Why it works |
|---|---|---|
| Quick Note from anywhere | Apple Notes | Capture in under two seconds or the thought is lost. |
| Checklists that auto-sort completed items | Apple Notes, Keep | Lightweight tasks without a separate app. |
| Inline #tags and smart folders | Bear, Apple Notes | Organization emerges from writing. |
| Backlinks and [[wikilinks]] | Obsidian, Bear | Links beat folders for retrieval. |
| Local-first Markdown files | Obsidian | Data ownership and portability, a core open-source trust signal. |
| Handwriting, sketch, and Pencil | Apple Notes | Captures what typing can't, which matters on iPad. |
| OCR and doc scanning | Apple Notes, Keep | Paper becomes searchable text. |
| Shared notes | Apple Notes, Keep | Household and team lists. |
| Locked / encrypted notes | Apple Notes, Bear | Selective privacy without a separate vault. |
| Color and pinned card grid | Google Keep | Spatial, glanceable recall for short notes. |
| Location and time reminders | Google Keep | The note resurfaces when relevant. |
| Notes linked to email and events | Outlook / OneNote, Notion | Meeting notes travel with their event and thread. |
| Typography-first editor | Bear | Writing feels calm, and polish signals quality. |
| Graph and canvas views | Obsidian | Optional spatial thinking for power users. |
| Markdown import and export | Apple Notes (26), Bear | No lock-in, which lowers the switching barrier. |
| Plugins | Obsidian | The community grows the product. |

## 4. Protocol and integration realities

**Gmail: the verification wall.** Every Gmail access scope (IMAP via `https://mail.google.com/`, `gmail.readonly`, `gmail.modify`) is "restricted." If that data passes through or rests on our servers, Google requires an **annual third-party CASA security assessment** ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)). Reported costs range from about $3,000–$6,000 ([Leviathan](https://www.leviathansecurity.com/programs/google-casa-cloud-application-security-assessment)) to older estimates of $15,000–$75,000 ([Nylas](https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide/)). OAuth app verification is still required even without servers. Unverified apps are capped at 100 users and show a warning screen.
→ Keep mail data on the device, never on our servers. Budget for verification. Design a bring-your-own-client-ID fallback ([DAVx⁵ approach](https://www.davx5.com/tested-with/google/)). The Gmail API gives us labels, history-based sync, and push. IMAP loses label semantics.

**Google Calendar and Contacts.** CalDAV and CardDAV work, but only with OAuth 2.0 ([CalDAV](https://developers.google.com/calendar/caldav/v2/guide), [CardDAV](https://developers.google.com/people/carddav)). Google's CardDAV does **not** expose contact labels or groups, so smart groups need the People API.

**Google Keep.** The API is enterprise-only and "not available for users with personal Google accounts" ([Keep API](https://developers.google.com/workspace/keep)). → Offer a Google Takeout import instead of sync.

**Microsoft.** Exchange Online EWS is **blocked by default from Oct 1, 2026** and **shut down permanently on April 1, 2027**. On-prem Exchange is unaffected ([MC1227454](https://mc.merill.net/message/MC1227454)). Microsoft Graph is the forward path for M365 and Outlook.com. IMAP/SMTP with OAuth2 (XOAUTH2) stays viable for mail only. Basic-auth SMTP AUTH is disabled by default at the end of December 2026 ([heise](https://heise.de/-11156432)).
→ Use Graph for M365 and Outlook.com. Use EWS only for on-prem. Never use basic auth.

**iCloud.** IMAP/SMTP (imap.mail.me.com:993, smtp.mail.me.com:587) and CalDAV/CardDAV, all with an **app-specific password**. There is no third-party OAuth ([Apple](https://support.apple.com/102525)). Resetting the Apple Account password revokes every app password, so we need a re-auth recovery flow. **Apple Notes has no public API.**

**Apple Notes export.** iOS/macOS 26 added **File → Export As → Markdown**, with attachments in a folder. → Build a polished "Import from Apple Notes" onboarding path instead of live sync.

**JMAP.** Fastmail is the reference implementation. Stalwart ships JMAP Mail, Calendars, Contacts, and Sharing ([Stalwart](https://www.stalw.art/collaboration)). JMAP Contacts is RFC 9610. JMAP Calendars was still an IETF draft as of late 2025 ([datatracker](https://datatracker.ietf.org/doc/draft-ietf-jmap-calendars)). Thunderbird has JMAP in "exploration," and Thundermail will speak it. JMAP is our best-fit protocol (stateless, mobile-efficient, push), but the big providers will not adopt it.

**Overall constraint.** We need a provider-adapter architecture, and **capabilities vary per account**: labels vs. folders, server-side snooze, notes sync, contact groups. The UI must show this honestly instead of failing silently.

## 5. Design principles

1. **One capture surface, four destinations.** A single quick-add parses natural language ("Lunch Fri 1pm", "Call Sam re: invoice", "#idea…") and routes it to an event, task, contact, or note, with a live parse preview before commit.
2. **Cross-vertical objects are the product.** Every email, event, contact, and note links to the others. A persistent context panel shows those links. Bundling only beats best-of-breed if the pieces connect.
3. **Consent-based attention.** A calm inbox by default: screener for new senders, bundled low-value mail, notifications only from people, tracker blocking on.
4. **Keyboard-first on desktop, thumb-first on mobile, one grammar.** ⌘K and single-key shortcuts on desktop, configurable swipes on touch, mapped to one shared action vocabulary.
5. **Honest capability states per account.** Explicit, friendly "not available for this account" states and import paths, never hidden features.
6. **Local-first, portable, ownable.** Markdown notes, one-click export, and no server-side mail storage by default. This is the open-source trust story, and it also shrinks Google's CASA scope.
7. **Progressive disclosure of power.** Simple defaults, FairEmail-depth settings behind an advanced layer.
8. **Reversibility everywhere.** Undo send, archive, and merge. Restore contacts to a point in time.
9. **Adaptive layouts from one design system.** Phone stack → tablet split → desktop three-pane, from shared tokens and components.
10. **No ads, no dark patterns, ever.** A visible brand promise, and the clearest differentiator against Outlook and Gmail free tiers.
