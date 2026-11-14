import { Accessory, AppFrameAccessory, StatusItem, Tooltip, TooltipContent, TooltipTrigger, useAppFrame, type AccessoryAction } from "@unicron/ui"

import { useCore } from "@/core/queries"

import { checkMail, useLiveStatus, type LiveStatus } from "./live-status"
import { useScreen } from "./screen"
import { useUi } from "./ui-store"

/** The bar under a countdown: one cell a second of the undo window. */
const bar = (live: LiveStatus) => (live.countdown !== undefined ? { value: live.countdown, max: live.total, segments: live.total } : undefined)
/** The strip's one action: UNDO, its own button beside the text area; a glyph once the strip is in the bottom row. */
const undoAction = (live: LiveStatus): AccessoryAction | undefined => (live.undo ? { label: "Undo", icon: "undo", onClick: live.undo } : undefined)

/** Presses the page head, which on a phone is the way into the section's folders (ADR-0084). */
const openFolders = () => [...document.querySelectorAll<HTMLElement>("[data-slot='page-head-switcher']")].find((el) => el.offsetParent !== null)?.click()

/**
 * The phone's status strip (States / 04): the live state above the bottom
 * row, and inside it once the page has scrolled. With no bottom row
 * (Settings) the frame floats it alone at the foot. An account that stopped
 * syncing is the section's banner on a phone, not a strip. With nothing
 * live, the place strip shows once the page has scrolled (States / 02).
 */
export function StatusStrip() {
  const frame = useAppFrame()
  const live = useLiveStatus()
  const place = useScreen((s) => s.strip)
  const inMail = useUi((s) => s.vertical === "mail" && !s.settings && !s.search)
  if (live && live.kind !== "not-syncing") {
    // While sending the strip opens Scheduled, where the message waits; while mail is fetched, the Folders sheet.
    const canOpenFolders = !!frame.head?.switcher
    const open =
      live.kind === "sending"
        ? () => useUi.getState().showMailTab("scheduled")
        : live.kind === "checking" || live.kind === "first-sync"
          ? inMail && canOpenFolders
            ? openFolders
            : () => useUi.getState().setVertical("mail")
          : undefined
    const label = live.kind === "sending" ? "Open Scheduled" : open ? (inMail ? "Open Folders" : "Open Mail") : undefined
    // Scrolled, the strip stands in the bottom row, where a send shows its seconds and UNDO only.
    const inRow = live.kind === "sending" && frame.minimized && frame.bottom?.variant === "tabs"
    return (
      <AppFrameAccessory
        tone={live.tone}
        meta={inRow ? undefined : live.meta}
        title={inRow ? "" : live.title}
        announce={live.announce}
        countdown={live.countdown}
        progress={inRow ? undefined : bar(live)}
        action={undoAction(live)}
        onOpen={open}
        openLabel={label}
      />
    )
  }
  // Nothing is live: once the page has scrolled, where you are and the newest item's name.
  if (!place || frame.detailOpen) return null
  return <AppFrameAccessory scrolledOnly meta={place.meta} title={place.title} />
}

/**
 * The sending strip inside a full-screen form on a phone (brief X4: every
 * phone screen shows it during the window). The form is a layer over the
 * frame, so the strip is drawn in it, at its foot. Only a send: other states
 * wait behind the form.
 */
export function FormStrip() {
  const frame = useAppFrame()
  const live = useLiveStatus()
  if (!frame.phone || live?.kind !== "sending") return null
  return (
    <div className="shrink-0 px-4 pb-4">
      <Accessory tone={live.tone} meta={live.meta} title={live.title} announce={live.announce} countdown={live.countdown} progress={bar(live)} action={undoAction(live)} />
    </div>
  )
}

/**
 * The end of the desktop's status line: two items at most, the live one
 * first, then the screen's own fact. An account that stopped syncing, or no
 * network, takes the fact's place in Mail, where the fact is the sync time
 * (Desktop / 05).
 * In Mail the idle fact is a button: "Check again".
 */
export function LineStatus({ fact }: { fact: string | null }) {
  const live = useLiveStatus()
  const { data: core } = useCore()
  const inMail = useUi((s) => s.vertical === "mail" && !s.settings && !s.search)
  // Mail's own fact is the sync time, which these two already say.
  const showFact = fact && !(inMail && (live?.kind === "not-syncing" || live?.kind === "offline"))
  return (
    <>
      {live && (
        <StatusItem
          tone={live.tone}
          mark={live.tone === "live" ? "square" : live.tone === "critical" ? "warning--alt" : undefined}
          text={live.line}
          announce={live.announce}
          countdown={live.countdown}
          progress={bar(live)}
          action={live.undo ? { label: "Undo", onClick: live.undo } : undefined}
        />
      )}
      {showFact &&
        (inMail && core && !live ? (
          <Tooltip>
            {/* A plain element takes the hover and the focus inside it, so the item keeps its own slot and name. */}
            <TooltipTrigger render={<span className="flex min-w-0" />}>
              <StatusItem text={fact} label="Check again" onClick={() => void checkMail()} />
            </TooltipTrigger>
            <TooltipContent>Check for new mail</TooltipContent>
          </Tooltip>
        ) : (
          <StatusItem text={fact} />
        ))}
    </>
  )
}
