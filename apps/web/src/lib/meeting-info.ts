// Reading the call out of an invitation (ADR-0030). The core does this for
// real accounts (crates/core/src/meeting.rs); this copy serves the web demo
// and keeps its rules: the same hosts, app links, labels, and booking tools.
import type { DialIn, ManageLink, MeetingInfo } from "@/core/types"

/** Known video-call hosts, and the path a meeting link starts with. */
const HOSTS: [string, string[]][] = [
  ["zoom.us", ["/j/", "/my/", "/w/", "/s/"]],
  ["zoomgov.com", ["/j/"]],
  ["meet.google.com", ["/"]],
  ["teams.microsoft.com", ["/l/meetup-join/", "/meet/"]],
  ["teams.live.com", ["/meet/"]],
  ["webex.com", ["/meet/", "/join/", "/wbxmjs/"]],
  ["meet.jit.si", ["/"]],
  ["whereby.com", ["/"]],
  ["facetime.apple.com", ["/join"]],
  ["meet.goto.com", ["/"]],
  ["global.gotomeeting.com", ["/join/"]],
  ["chime.aws", ["/"]],
]

const tokens = (t: string) => t.split(/[\s<>"'()[\]{}|]+/).map((x) => x.replace(/[.,;:!?]+$/, ""))
const split = (url: string) => /^https:\/\/([^/?#]+)([^]*)$/.exec(url)

export function meetingLink(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    for (const url of tokens(t ?? "")) {
      const m = split(url)
      if (!m) continue
      const host = m[1]!.toLowerCase()
      const path = m[2]!
      if (HOSTS.some(([h, paths]) => (host === h || host.endsWith(`.${h}`)) && path.length > 1 && paths.some((x) => path.startsWith(x) || (x === "/" && path.length > 3)))) return url
    }
  }
  return null
}

export function serviceOf(url: string): string | null {
  const host = split(url)?.[1]?.toLowerCase() ?? ""
  const is = (h: string) => host === h || host.endsWith(`.${h}`)
  if (is("zoom.us") || is("zoomgov.com")) return "zoom"
  if (is("meet.google.com")) return "meet"
  if (is("teams.microsoft.com") || is("teams.live.com")) return "teams"
  if (is("webex.com")) return "webex"
  if (is("meet.jit.si")) return "jitsi"
  if (is("whereby.com")) return "whereby"
  if (is("facetime.apple.com")) return "facetime"
  if (is("meet.goto.com") || is("gotomeeting.com")) return "goto"
  if (is("chime.aws")) return "chime"
  return null
}

export function appLink(url: string): string | null {
  const service = serviceOf(url)
  if (service === "zoom") {
    const host = split(url)![1]!
    const id = /\/j\/(\d+)/.exec(url)?.[1]
    if (!id) return null
    const pwd = /[?&]pwd=([^&#]+)/.exec(url)?.[1]
    return `zoommtg://${host}/join?action=join&confno=${id}${pwd ? `&pwd=${pwd}` : ""}`
  }
  if (service === "teams") {
    const m = /^https:\/\/teams\.(?:microsoft|live)\.com(\/.*)$/.exec(url)
    return m ? `msteams:${m[1]}` : null
  }
  return null
}

function afterLabel(text: string, labels: string[]): string | null {
  for (const line of text.split("\n")) {
    const lower = line.toLowerCase()
    for (const l of labels) {
      const i = lower.indexOf(l)
      if (i < 0) continue
      const after = line.slice(i + l.length).trimStart()
      if (!after.startsWith(":")) continue
      const value = after.slice(1).replace(/^[ \t#]+/, "").split(/\s{2,}|\t/)[0]!.trim()
      if (value && value.length <= 40) return value
    }
  }
  return null
}

function dialIns(text: string): DialIn[] {
  const out: DialIn[] = []
  let phones = false
  for (const line of text.split("\n")) {
    const l = line.toLowerCase()
    if (["dial", "phone", "call in", "tap", "tel"].some((w) => l.includes(w))) phones = true
    else if (!l.trim() || l.includes("://")) phones = phones && !l.trim()
    const plus = line.indexOf("+")
    if (plus < 0) continue
    const tail = line.slice(plus)
    const number = /^[\d \-().+]*/.exec(tail)![0].replace(/[ \-(]+$/, "")
    const digits = number.replace(/\D/g, "")
    if (digits.length < 8 || digits.length > 15) continue
    const after = tail.slice(number.length)
    let codes: string
    if (after.startsWith(",,")) codes = /^[\d,#*]*/.exec(after)![0]
    else {
      const pin = afterLabel(line, ["pin", "conference id", "meeting id", "access code"])
      if (pin) codes = pin.replace(/\D/g, "") ? `,,${pin.replace(/\D/g, "")}#` : ""
      else if (phones) codes = ""
      else continue
    }
    const rest = after.replace(/^[\d,#*]*/, "").trim().replace(/^[-–]\s*/, "")
    const label = rest && rest.length <= 40 && !rest.toLowerCase().startsWith("pin") && /\p{L}/u.test(rest) ? rest : null
    const tel = `tel:+${digits}${codes.replace(/#/g, "%23")}`
    if (!out.some((d) => d.tel === tel)) out.push({ number: number.trim(), label, tel })
    if (out.length === 3) break
  }
  return out
}

const group = (d: string) => (d.length === 11 ? `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}` : d.length === 9 || d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d)

export function meetingInfo(...texts: (string | null | undefined)[]): MeetingInfo | null {
  const url = meetingLink(...texts)
  const service = url && serviceOf(url)
  if (!url || !service) return null
  const all = texts.filter(Boolean).join("\n")
  const fromLink = service === "zoom" ? /\/j\/(\d{9,})/.exec(url)?.[1] : undefined
  const id = afterLabel(all, ["meeting id", "conference id", "meeting number", "access code"]) ?? (fromLink ? group(fromLink) : null)
  const passcode = afterLabel(all, ["passcode", "password"])
  return { service, url, appUrl: appLink(url), meetingId: id && /\d/.test(id) ? id : null, passcode: passcode && !passcode.includes("://") ? passcode : null, dialIn: dialIns(all) }
}

export function manageLinks(...texts: (string | null | undefined)[]): ManageLink[] {
  const out: ManageLink[] = []
  for (const t of texts) {
    for (const url of tokens(t ?? "")) {
      const m = split(url)
      if (!m) continue
      const host = m[1]!.toLowerCase()
      const path = m[2]!.toLowerCase()
      const is = (h: string) => host === h || host.endsWith(`.${h}`)
      const found: [string, string] | null =
        is("calendly.com") && path.startsWith("/reschedulings/") ? ["reschedule", "Calendly"]
        : is("calendly.com") && path.startsWith("/cancellations/") ? ["cancel", "Calendly"]
        : is("cal.com") && path.startsWith("/reschedule/") ? ["reschedule", "Cal.com"]
        : is("cal.com") && path.startsWith("/booking/") ? [path.includes("cancel=true") ? "cancel" : "manage", "Cal.com"]
        : is("savvycal.com") && /\/(reschedule|cancel|manage)/.test(path) ? [path.includes("cancel") ? "cancel" : path.includes("reschedule") ? "reschedule" : "manage", "SavvyCal"]
        : is("acuityscheduling.com") && (path.includes("action=") || path.includes("/appointments/")) ? ["manage", "Acuity"]
        : is("doodle.com") && path.startsWith("/meeting/") ? ["manage", "Doodle"]
        : null
      if (found && !out.some((x) => x.url === url)) out.push({ action: found[0], tool: found[1], url })
    }
  }
  return out
}
