# ADR-0037 · Quick Note (Phase 27)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes linked to events, contacts, and conversations), [ADR-0036](0036-sender-profile.md) (the adaptive sheet)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **Quick Note from anywhere** to Apple Notes: a thought gets written down before it's lost, in the context it came from. Here, starting a note from an event or a conversation used to open the full editor in Notes. That pulled you away from what you were doing.

## Decisions

### Three ways in, from anywhere

- **⌥N**, anywhere in the app, except while typing in a field, where Option+N types a character. It's listed under **Shortcuts and gestures** as a key that doesn't change.
- **⌘K → Quick note about …**, which names what the note will link to.
- **The Quick note button** beside **New note** in every Notes section: a conversation, an event, a contact, or the sender profile. This is the way in on phones, which have no ⌥N.

**New note** still opens the full editor in Notes, for when you mean to write at length.

### Linked to what's open

Views say what they show. The open conversation, event, or contact registers itself, and it's cleared when it closes. Quick Note then opens with a chip for it:

- **The chip names the link as it will be saved.** For a conversation, that's its first subject, as on every other note link.
- **× removes the link** for a note that's only loosely related.
- **"Already noted here"** lists notes that already link to it, one tap from opening them.
- **Holidays and moon phases can't be linked;** with those open, the note isn't linked to anything. In Notes itself, nothing is linked either.

### Closing saves

As in Apple Notes, there's nothing to forget to press:

- **Closing saves** a non-empty note: with Esc, the close button, a tap outside, or dragging the sheet down. An empty one is dropped.
- **Save note** and **⌘Enter** do the same, for people who expect a button.
- **You stay where you were.** A confirmation says where it went ("Saved to Notes, linked to Token audit") and offers **Open** to jump to it.
- **The text is plain;** the first line is the title, as in any note. Formatting comes later, in the full editor.

### The sheet follows the adaptive rule

Quick Note uses the adaptive sheet (ADR-0036):

- **On phones:** a three-quarter bottom sheet with the small floating close button in the bottom-right corner. **Save note** is a pill at the bottom-left, level with it, so both actions are in the thumb zone.
- **On wider screens:** a panel on the right, with Save at the bottom.

## Verification

- **Browser, demo (`phase27`, 16 checks):**
  - ⌥N from a conversation opens a note linked to it, with the chip named as it'll be saved; closing saves it, Mail stays put, and the conversation lists it;
  - ⌘K names what it links to; notes already linked are listed;
  - removing the link saves a plain note; an empty one saves nothing;
  - from an event's Notes section, the note links to the event and the event lists it; ⌘Enter saves, and **Open** jumps to it;
  - with nothing open, the note isn't linked;
  - on a phone: the three-quarter bottom sheet, Save level with Close at the bottom, and the close button saves.

  All earlier demo suites still pass.
- **No new core code.** Quick Note uses the existing `create_note` and `note_link_for` commands, covered by the core and gateway tests.

## Consequences

- **One Quick Note at a time.** Apple keeps a running Quick Note per page; here each opening makes a new note, and "Already noted here" leads back to earlier ones.
- **⌥N isn't remappable yet.** It's global, while remappable keys are per area (ADR-0032). It can join the table as an "everywhere" area later.
