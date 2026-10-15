# ADR-0033 · Regional holidays (Phase 23)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0024](0024-interesting-calendars.md) (interesting calendars)

ADR-0024 added national holidays for 13 countries, computed on the device, and left regions out: *regional days vary too much to guess.* That's true for some countries and not others. In Germany, a Bavarian has Corpus Christi and All Saints' Day off and a Berliner doesn't. In Scotland, there's no Easter Monday, and the summer bank holiday comes three weeks earlier than in England. For people in these places, a national calendar is wrong on days that matter. The [competitive analysis](../research/competitive-analysis.md) §3 credits **interesting calendars** to Fantastical and Google for "useful context with zero setup". Context that's wrong for your region isn't useful.

## Decisions

### Only regions whose days follow fixed rules

A regional day is included only when a rule computes it: a date, a day counted from Easter, the nth weekday of a month, or the weekday before or after a date. That covers 40 regions in six countries:

| Country | Regions | Examples |
|---|---|---|
| Germany | All 16 Länder | Corpus Christi, All Saints' Day, Reformation Day, Saxony's Day of Repentance and Prayer (the Wednesday before 23 November) |
| The United Kingdom | England, Wales, Scotland, Northern Ireland | Scotland: 2 January, St Andrew's Day, an early-August summer holiday, and no Easter Monday. Northern Ireland: St Patrick's Day, the Battle of the Boyne |
| Canada | 9 provinces | Family Day and its other names, Saint-Jean-Baptiste Day, the August civic holidays |
| Australia | 6 states and 2 territories | Each state's Labour Day, Easter Saturday and Sunday, the Melbourne Cup, Canberra Day, Queensland's October King's Birthday |
| France | Alsace and Moselle | Good Friday, St Stephen's Day |
| Portugal | The Azores, Madeira | Azores Day, Madeira Day |

**Left out, and why:**

- **Spain's communities, Italy's regions, Brazil's states, and the US states.** Their days are set by annual decree, by city, or vary too much to compute honestly. A guessed day is worse than none, because people plan around it.
- **Western Australia's King's Birthday.** The governor proclaims it each year, so the region drops the national June date and shows no replacement.
- **City holidays** (Augsburg's Peace Festival, Brisbane's Ekka), and days off for only some workers, such as bank holidays that only banks keep.

The Spain, Italy, Brazil, and US calendars show no region picker, so nobody gets the impression that a region was considered and found empty.

### One region per country, picked under its calendar

Once a country is added, a **Region** picker appears under it, set to **Nationwide only** by default. Picking a region:

- **adds the region's days** to the country's calendar, and drops national days the region doesn't keep (Scotland's Easter Monday, for example). This avoids a second calendar showing the same national days twice.
- **renames the calendar** "Holidays in Bavaria", so the sidebar and every event say where they're from. In the list of countries, the country stays in view next to the new name, so the A–Z list still reads.
- **moves days off by the same rules.** In 2022, 1 January was a Saturday and 2 January a Sunday, so Scotland had Monday 3 and Tuesday 4 off. Northern Ireland's Boyne holiday moves to Monday when 12 July is a Sunday.

**Each day says whether it's regional.** Corpus Christi in Bavaria reads "A public holiday in Bavaria, not across Germany." With no region picked, a national day in a country that has regions says how to add yours: "pick it in Add holidays and more."

The "Your region" badge from Phase 14 is now **Your country**, because *region* means something specific now.

### The rules are data, in the core and the demo

The regional days are a table (`EXTRAS`: country, regions, rule, name), plus a short list of national days that some regions don't keep (`DROPS`). The core and the web demo carry the same table, as they already do for national holidays. The pick is a core setting (`holiday_regions`, country code → region code), so every browser on the gateway and every device shows the same days. An unknown region is refused, and a region no longer listed falls back to nationwide.

## Verification

- **Core (`cargo test -p pim-core`, 198 tests):**
  - published dates: Bavaria's 2026 Corpus Christi, Saxony's Day of Repentance and Prayer for four years, Scotland's 2026 summer holiday, Scotland's 2022 New Year substitutes, Northern Ireland's 2026 Boyne substitute, Victoria's Melbourne Cup and Labour Day, Queensland's King's Birthday, the ACT's Reconciliation Day, Ontario's Family Day, and the Azores Day;
  - every region's list stays sorted, and an unknown region gives just the nation;
  - picking a region renames the calendar, adds its days, and explains them; going back to nationwide removes them; refusals change nothing.
- **App (`cargo test -p pim-app`):** the command through the dispatcher, including a region from another country.
- **Browser, demo (`phase23`, 18 checks):**
  - no picker until a country is added; Germany offers its 16 Länder;
  - Bavaria shows All Saints' Day and explains it's regional; Saxony drops it and adds its November Wednesday; nationwide removes both and points to the picker;
  - Scotland renames the UK calendar and shows St Andrew's Day; the US offers no picker;
  - the picker fits a phone.

  All earlier demo suites still pass. `phase14` reads the badge's new name.
- **Browser, gateway (`gateway-p23`):**
  - the desktop picks Saxony, and a separately signed-in tablet gets Saxony's day and the new name;
  - the gateway refuses a region the country doesn't have;
  - going back to nationwide from the tablet removes the day on the desktop.

## Consequences

- Rules can change: Berlin added International Women's Day in 2019, and Mecklenburg-Western Pomerania in 2023. The rules hold the current law and don't model history. Past years can show a regional day that wasn't yet a holiday then.
- One region per country. Someone who works across a border, say in Bavaria while living in Baden-Württemberg, picks one. Both are close.
- Adding more regions is a table change in two files. A region joins only when its days have fixed rules.
