import type { Occurrence } from "@/core/types"

/** "Zoom", "Google Meet" … from a meeting link, for labels. */
export function meetingService(url: string) {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // Not a URL; fall through to the generic name.
  }
  const is = (h: string) => host === h || host.endsWith(`.${h}`)
  if (is("zoom.us") || is("zoomgov.com")) return "Zoom"
  if (is("meet.google.com")) return "Google Meet"
  if (is("teams.microsoft.com") || is("teams.live.com")) return "Teams"
  if (is("webex.com")) return "Webex"
  if (is("meet.jit.si")) return "Jitsi"
  if (is("whereby.com")) return "Whereby"
  if (is("facetime.apple.com")) return "FaceTime"
  if (is("meet.goto.com") || is("gotomeeting.com")) return "GoTo"
  if (is("chime.aws")) return "Chime"
  return "the call"
}

/** The location to show: a bare meeting link reads as its service ("Google Meet"), not a long URL. */
export function placeLabel(o: Pick<Occurrence, "location" | "meetingUrl">) {
  return o.meetingUrl && o.location?.trim() === o.meetingUrl ? meetingService(o.meetingUrl) : o.location
}
