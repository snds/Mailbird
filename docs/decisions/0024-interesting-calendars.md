# ADR-0024 · Interesting calendars: holidays and moon phases from rules, on the device (Phase 14)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0019](0019-connected-calendar.md) (the Birthdays calendar)

The [competitive analysis](../research/competitive-analysis.md) §3 lists **Interesting calendars (holidays, sports)** from Fantastical and Google: useful context with zero setup. This phase adds national holidays for 13 countries and moon phases.

## Decisions

### Computed from rules, not subscribed from a feed

Google and Fantastical serve these as hosted iCalendar feeds. We compute them in the core (`interesting.rs`) instead:

- **Nothing is fetched.** A feed URL would tell its host who uses the app, and from where. Computing keeps the "no tracking" promise.
- **It works offline and never goes stale.** Rules don't expire, and there's no feed to break or go dark.
- **It costs nothing to host.** An open-source app with no servers of its own can't promise a feed's uptime.

The tradeoff is accuracy at the edges. Rules can't know one-off holidays a government declares (a royal funeral, a jubilee). Those are rare, and the dialog says it lists national holidays only.

### What's covered

- **Holidays (13 countries):** Australia, Brazil, Canada, France, Germany, Ireland, Italy, Mexico, the Netherlands, Portugal, Spain, the United Kingdom (England and Wales), and the United States.
  - The rules are fixed dates, "nth weekday of the month", and days counted from Western Easter (anonymous Gregorian algorithm).
  - Special cases are handled: Victoria Day (the Monday before 25 May), St Brigid's Day (1 February when it's a Friday), and King's Day (the 26th when the 27th is a Sunday).
  - **Days off that move are listed too:** "(observed)" under the US federal rule (Saturday → Friday, Sunday → Monday), and "(substitute day)" in the UK, Ireland, Canada, and Australia (the next free weekday).
  - **National days only.** Regional holidays (German states, Spanish communities, US states) vary too much to guess. Adding regions is a data change, not a design change.
- **Moon phases:** new, first quarter, full, and last quarter, by Meeus (*Astronomical Algorithms*, ch. 49) without the planetary terms. That's within about two minutes of the US Naval Observatory's published times (tested), which is plenty for an all-day item. The event view gives the exact local time ("Full moon at 01:28").

### Built like Birthdays: a read-only calendar on the device

Adding one inserts a read-only, device-only collection (`interesting:holidays-pt`, `interesting:moon`). Its days are generated when the calendar is read, as all-day items on the local date in the store's time zone. So:

- **It shows and hides like any calendar.** The checkbox applies, and so do calendar sets (ADR-0021).
- **Clashes and Find a time ignore it,** because all-day items don't block time.
- **Removing it** deletes the collection and nothing else.

The sidebar groups these under **Holidays and more**. **Add holidays and more** opens the catalog, with the country your device's language points at first ("Your region"). Nothing is added for you: a calendar you didn't ask for is clutter.

## Verification

- **Core (`cargo test -p pim-core`, 177 tests):**
  - Easter for six years (including 2038 and 2285).
  - Holiday rules: last and nth weekdays, US observed days, UK substitute days for a weekend Christmas, Victoria Day, St Brigid's Day, King's Day, Whit Monday, Corpus Christi, and every country sorted.
  - Moon phases within 3 minutes of published times, with 12 or 13 full moons in a year.
  - Adding, listing, read-only collections, local-midnight occurrences in Europe/Lisbon, event notes, hiding, removing, and the device calendar still being created.
- **App (`cargo test -p pim-app`):** the catalog, adding, occurrences through the dispatcher, and removing.
- **Browser, demo (`phase14`, 12 checks):**
  - Your region first, 13 countries.
  - Adding gives its own read-only group.
  - Christmas and moon phases on the agenda.
  - Event views explain themselves and can't be edited.
  - Hiding, removing, and phone width.
  - All 19 earlier suites still pass.
- **Browser, gateway (`gateway-p14`):** added through the real core, German Christmas days and the December full moon from the core, the exact time read-only, surviving a reload, and removal.

## Consequences

- One-off and regional holidays aren't covered. Sports calendars (the other half of the harvest row) need live data, so they'd need a feed after all; that's left for when there's a privacy-respecting source.
- Holiday names are in English. Localizing them follows the app's own localization, which doesn't exist yet.
- The rules need a yearly sanity check against official lists, since governments do change holidays (Brazil added 20 November nationally in 2024).
