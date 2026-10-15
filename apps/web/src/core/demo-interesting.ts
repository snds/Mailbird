// Interesting calendars for the web demo: the same holiday rules and moon
// phase formula as the core's `interesting.rs` (ADR-0024), on the device
// clock. Dates are [year, month (1–12), day].

type Day = [number, number, number]

export const INTERESTING = "interesting:"
export const SPECIAL = "special:"
export const MOON = "interesting:moon"

export const HOLIDAY_COUNTRIES: { code: string; country: string; color: string }[] = [
  { code: "AU", country: "Australia", color: "#0f766e" },
  { code: "BR", country: "Brazil", color: "#15803d" },
  { code: "CA", country: "Canada", color: "#b91c1c" },
  { code: "FR", country: "France", color: "#1d4ed8" },
  { code: "DE", country: "Germany", color: "#a16207" },
  { code: "IE", country: "Ireland", color: "#16a34a" },
  { code: "IT", country: "Italy", color: "#047857" },
  { code: "MX", country: "Mexico", color: "#be123c" },
  { code: "NL", country: "the Netherlands", color: "#ea580c" },
  { code: "PT", country: "Portugal", color: "#b45309" },
  { code: "ES", country: "Spain", color: "#c2410c" },
  { code: "GB", country: "the United Kingdom", color: "#4338ca" },
  { code: "US", country: "the United States", color: "#2563eb" },
]

export const holidayId = (code: string) => `${INTERESTING}holidays-${code.toLowerCase()}`

const utcDay = (d: Day) => new Date(Date.UTC(d[0], d[1] - 1, d[2]))
const toDay = (t: Date): Day => [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
const add = (d: Day, n: number): Day => toDay(new Date(utcDay(d).getTime() + n * 86_400_000))
const dow = (d: Day) => utcDay(d).getUTCDay() // 0 Sunday … 6 Saturday
const key = (d: Day) => d.map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-")

export function easter(y: number): Day {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return [y, Math.floor(n / 31), (n % 31) + 1]
}

/** The nth weekday (0 Sunday) of a month; n = -1 is the last. */
const nth = (y: number, m: number, wd: number, n: number): Day => {
  if (n > 0) {
    const first: Day = [y, m, 1]
    return add(first, ((wd - dow(first) + 7) % 7) + (n - 1) * 7)
  }
  const last = add(m === 12 ? [y + 1, 1, 1] : [y, m + 1, 1], -1)
  return add(last, -((dow(last) - wd + 7) % 7))
}

const MON = 1, THU = 4, FRI = 5, SUN = 0
const weekend = (d: Day) => dow(d) === 0 || dow(d) === 6

export function holidays(code: string, y: number): [Day, string][] {
  const e = easter(y)
  const ed = (n: number) => add(e, n)
  const D = (m: number, d: number): Day => [y, m, d]
  const lists: Record<string, [Day, string][]> = {
    US: [[D(1, 1), "New Year’s Day"], [nth(y, 1, MON, 3), "Martin Luther King Jr. Day"], [nth(y, 2, MON, 3), "Presidents’ Day"], [nth(y, 5, MON, -1), "Memorial Day"], [D(6, 19), "Juneteenth"], [D(7, 4), "Independence Day"], [nth(y, 9, MON, 1), "Labor Day"], [nth(y, 10, MON, 2), "Columbus Day"], [D(11, 11), "Veterans Day"], [nth(y, 11, THU, 4), "Thanksgiving"], [D(12, 25), "Christmas Day"]],
    CA: [[D(1, 1), "New Year’s Day"], [ed(-2), "Good Friday"], [add(D(5, 25), -(((dow(D(5, 25)) - MON + 7) % 7) || 7)), "Victoria Day"], [D(7, 1), "Canada Day"], [nth(y, 9, MON, 1), "Labour Day"], [D(9, 30), "National Day for Truth and Reconciliation"], [nth(y, 10, MON, 2), "Thanksgiving"], [D(11, 11), "Remembrance Day"], [D(12, 25), "Christmas Day"], [D(12, 26), "Boxing Day"]],
    MX: [[D(1, 1), "New Year’s Day"], [nth(y, 2, MON, 1), "Constitution Day"], [nth(y, 3, MON, 3), "Benito Juárez’s Birthday"], [D(5, 1), "Labour Day"], [D(9, 16), "Independence Day"], [nth(y, 11, MON, 3), "Revolution Day"], [D(12, 25), "Christmas Day"]],
    BR: [[D(1, 1), "New Year’s Day"], [ed(-48), "Carnival"], [ed(-47), "Carnival"], [ed(-2), "Good Friday"], [D(4, 21), "Tiradentes Day"], [D(5, 1), "Labour Day"], [ed(60), "Corpus Christi"], [D(9, 7), "Independence Day"], [D(10, 12), "Our Lady of Aparecida"], [D(11, 2), "All Souls’ Day"], [D(11, 15), "Republic Day"], [D(11, 20), "Black Consciousness Day"], [D(12, 25), "Christmas Day"]],
    GB: [[D(1, 1), "New Year’s Day"], [ed(-2), "Good Friday"], [ed(1), "Easter Monday"], [nth(y, 5, MON, 1), "Early May bank holiday"], [nth(y, 5, MON, -1), "Spring bank holiday"], [nth(y, 8, MON, -1), "Summer bank holiday"], [D(12, 25), "Christmas Day"], [D(12, 26), "Boxing Day"]],
    IE: [[D(1, 1), "New Year’s Day"], [dow(D(2, 1)) === FRI ? D(2, 1) : nth(y, 2, MON, 1), "St Brigid’s Day"], [D(3, 17), "St Patrick’s Day"], [ed(1), "Easter Monday"], [nth(y, 5, MON, 1), "May bank holiday"], [nth(y, 6, MON, 1), "June bank holiday"], [nth(y, 8, MON, 1), "August bank holiday"], [nth(y, 10, MON, -1), "October bank holiday"], [D(12, 25), "Christmas Day"], [D(12, 26), "St Stephen’s Day"]],
    FR: [[D(1, 1), "New Year’s Day"], [ed(1), "Easter Monday"], [D(5, 1), "Labour Day"], [D(5, 8), "Victory in Europe Day"], [ed(39), "Ascension Day"], [ed(50), "Whit Monday"], [D(7, 14), "Bastille Day"], [D(8, 15), "Assumption Day"], [D(11, 1), "All Saints’ Day"], [D(11, 11), "Armistice Day"], [D(12, 25), "Christmas Day"]],
    DE: [[D(1, 1), "New Year’s Day"], [ed(-2), "Good Friday"], [ed(1), "Easter Monday"], [D(5, 1), "Labour Day"], [ed(39), "Ascension Day"], [ed(50), "Whit Monday"], [D(10, 3), "German Unity Day"], [D(12, 25), "Christmas Day"], [D(12, 26), "Second Day of Christmas"]],
    ES: [[D(1, 1), "New Year’s Day"], [D(1, 6), "Epiphany"], [ed(-2), "Good Friday"], [D(5, 1), "Labour Day"], [D(8, 15), "Assumption Day"], [D(10, 12), "National Day of Spain"], [D(11, 1), "All Saints’ Day"], [D(12, 6), "Constitution Day"], [D(12, 8), "Immaculate Conception"], [D(12, 25), "Christmas Day"]],
    IT: [[D(1, 1), "New Year’s Day"], [D(1, 6), "Epiphany"], [ed(1), "Easter Monday"], [D(4, 25), "Liberation Day"], [D(5, 1), "Labour Day"], [D(6, 2), "Republic Day"], [D(8, 15), "Assumption Day"], [D(11, 1), "All Saints’ Day"], [D(12, 8), "Immaculate Conception"], [D(12, 25), "Christmas Day"], [D(12, 26), "St Stephen’s Day"]],
    NL: [[D(1, 1), "New Year’s Day"], [ed(0), "Easter Sunday"], [ed(1), "Easter Monday"], [dow(D(4, 27)) === SUN ? D(4, 26) : D(4, 27), "King’s Day"], [D(5, 5), "Liberation Day"], [ed(39), "Ascension Day"], [ed(49), "Whit Sunday"], [ed(50), "Whit Monday"], [D(12, 25), "Christmas Day"], [D(12, 26), "Second Day of Christmas"]],
    PT: [[D(1, 1), "New Year’s Day"], [ed(-2), "Good Friday"], [ed(0), "Easter Sunday"], [D(4, 25), "Freedom Day"], [D(5, 1), "Labour Day"], [ed(60), "Corpus Christi"], [D(6, 10), "Portugal Day"], [D(8, 15), "Assumption Day"], [D(10, 5), "Republic Day"], [D(11, 1), "All Saints’ Day"], [D(12, 1), "Restoration of Independence"], [D(12, 8), "Immaculate Conception"], [D(12, 25), "Christmas Day"]],
    AU: [[D(1, 1), "New Year’s Day"], [D(1, 26), "Australia Day"], [ed(-2), "Good Friday"], [ed(1), "Easter Monday"], [D(4, 25), "Anzac Day"], [nth(y, 6, MON, 2), "King’s Birthday"], [D(12, 25), "Christmas Day"], [D(12, 26), "Boxing Day"]],
  }
  const base = (lists[code] ?? []).sort((a, b) => key(a[0]).localeCompare(key(b[0])))
  const out = [...base]
  if (code === "US") {
    for (const [d, n] of base) {
      if (dow(d) === 6) out.push([add(d, -1), `${n} (observed)`])
      if (dow(d) === 0) out.push([add(d, 1), `${n} (observed)`])
    }
  } else if (["GB", "AU", "CA", "IE"].includes(code)) {
    const movable = ["New Year’s Day", "Christmas Day", "Boxing Day", "St Stephen’s Day", "St Patrick’s Day", "Australia Day", "Canada Day"]
    const taken = base.map(([d]) => key(d)).filter((_, i) => !weekend(base[i]![0]))
    for (const [d, n] of base.filter(([d, n]) => weekend(d) && movable.includes(n))) {
      let m = add(d, 1)
      while (weekend(m) || taken.includes(key(m))) m = add(m, 1)
      taken.push(key(m))
      out.push([m, `${n} (substitute day)`])
    }
  }
  return out.sort((a, b) => key(a[0]).localeCompare(key(b[0])))
}

export type Phase = "New moon" | "First quarter" | "Full moon" | "Last quarter"

/** Meeus ch. 49 without planetary terms, like the core: within minutes. */
function phaseTime(k0: number, phase: Phase): number {
  const k = k0 + { "New moon": 0, "First quarter": 0.25, "Full moon": 0.5, "Last quarter": 0.75 }[phase]
  const t = k / 1236.85
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * t * t - 0.00000015 * t ** 3 + 0.00000000073 * t ** 4
  const e = 1 - 0.002516 * t - 0.0000074 * t * t
  const r = (x: number) => (x * Math.PI) / 180
  const m = r(2.5534 + 29.1053567 * k - 0.0000014 * t * t - 0.00000011 * t ** 3)
  const mp = r(201.5643 + 385.81693528 * k + 0.0107582 * t * t + 0.00001238 * t ** 3 - 0.000000058 * t ** 4)
  const f = r(160.7108 + 390.67050284 * k - 0.0016118 * t * t - 0.00000227 * t ** 3 + 0.000000011 * t ** 4)
  const om = r(124.7746 - 1.56375588 * k + 0.0020672 * t * t + 0.00000215 * t ** 3)
  const s = Math.sin
  let c: number
  if (phase === "New moon" || phase === "Full moon") {
    const [a, b, cc, d, g] = phase === "New moon" ? [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739] : [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734]
    c = a * s(mp) + b * e * s(m) + cc * s(2 * mp) + d * s(2 * f) + g * e * s(mp - m) - 0.00515 * e * s(mp + m) + 0.00208 * e * e * s(2 * m) - 0.00111 * s(mp - 2 * f) - 0.00057 * s(mp + 2 * f) + 0.00056 * e * s(2 * mp + m) - 0.00042 * s(3 * mp) + 0.00042 * e * s(m + 2 * f) + 0.00038 * e * s(m - 2 * f) - 0.00024 * e * s(2 * mp - m) - 0.00017 * s(om)
  } else {
    c = -0.62801 * s(mp) + 0.17172 * e * s(m) - 0.01183 * e * s(mp + m) + 0.00862 * s(2 * mp) + 0.00804 * s(2 * f) + 0.00454 * e * s(mp - m) + 0.00204 * e * e * s(2 * m) - 0.0018 * s(mp - 2 * f) - 0.0007 * s(mp + 2 * f) - 0.0004 * s(3 * mp) - 0.00034 * e * s(2 * mp - m) + 0.00032 * e * s(m + 2 * f) + 0.00032 * e * s(m - 2 * f) - 0.00028 * e * e * s(mp + 2 * m) + 0.00027 * e * s(2 * mp + m) - 0.00017 * s(om)
    const w = 0.00306 - 0.00038 * e * Math.cos(m) + 0.00026 * Math.cos(mp) - 0.00002 * Math.cos(mp - m) + 0.00002 * Math.cos(mp + m) + 0.00002 * Math.cos(2 * f)
    c += phase === "First quarter" ? w : -w
  }
  return Math.round((jde + c - 2440587.5) * 86400) - 69
}

export function moonPhases(from: number, to: number): [number, Phase][] {
  const lunation = 29.530588861 * 86400
  const out: [number, Phase][] = []
  for (let k = Math.floor((from - 947_182_440) / lunation) - 1; phaseTime(k, "New moon") < to; k++) {
    for (const p of ["New moon", "First quarter", "Full moon", "Last quarter"] as Phase[]) {
      const t = phaseTime(k, p)
      if (t >= from && t < to) out.push([t, p])
    }
  }
  return out
}

/** (local date, index on that date, title) in [from, to), with a day's slack. */
export function daysOf(cal: string, from: number, to: number): [Day, number, string][] {
  const out: [Day, number, string][] = []
  const push = (d: Day, title: string) => out.push([d, out.filter(([x]) => key(x) === key(d)).length, title])
  if (cal === MOON) {
    for (const [t, p] of moonPhases(from - 86400, to + 86400)) {
      const l = new Date(t * 1000)
      push([l.getFullYear(), l.getMonth() + 1, l.getDate()], p)
    }
  } else {
    const c = HOLIDAY_COUNTRIES.find((x) => holidayId(x.code) === cal)
    if (c) {
      for (let y = new Date((from - 86400) * 1000).getFullYear(); y <= new Date((to + 86400) * 1000).getFullYear(); y++) {
        for (const [d, n] of holidays(c.code, y)) push(d, n)
      }
    }
  }
  return out
}

export const dayKey = key
/** Local midnight of a date, in Unix seconds. */
export const localMidnight = (d: Day, plus = 0) => Math.floor(new Date(d[0], d[1] - 1, d[2] + plus).getTime() / 1000)
export const parseDay = (s: string): Day => s.split("-").map(Number) as Day
