import { useRef, useState, type ReactNode } from "react"

import { Icon, type IconName } from "@/components/icon"
import { cn } from "@/lib/utils"

interface SwipeAction {
  icon: IconName
  label: string
  /** Background utility for the revealed action, bound to a semantic token. */
  tone: string
  onCommit: () => void
}

type Side = SwipeAction | null

/** Fraction of the row width past which releasing commits the action. */
const COMMIT_AT = 0.35
/** Past this, a long swipe's action takes over (Spark and Outlook's two stages). */
const LONG_AT = 0.7
/** Movement before we decide whether the gesture is a swipe or a scroll. */
const SLOP = 10

/**
 * Touch swipe for list rows (Apple Mail grammar). Touch and pen only; a mouse
 * keeps normal click and text selection. `touch-action: pan-y` hands vertical
 * movement to the browser, so swiping never fights scrolling. Every swipe
 * action also exists as a button and a shortcut, so nothing is gesture-only.
 * A side set to null doesn't swipe; a missing long action repeats the short one.
 */
export function SwipeRow({ start, end, startLong, endLong, children }: { start: Side; end: Side; startLong?: Side; endLong?: Side; children: ReactNode }) {
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  // Row width, measured when a gesture starts (render must not read refs).
  const [w, setW] = useState(360)
  const ref = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ x: number; y: number; id: number; swiping: boolean; armed: number } | null>(null)
  const swallowClick = useRef(false)

  const width = () => ref.current?.offsetWidth ?? w
  const reset = () => {
    setSettling(true)
    setDx(0)
  }
  /** What a swipe of `mx` pixels would do on release (null: nothing). */
  const actionAt = (mx: number, width: number): SwipeAction | null => {
    const [short, long] = mx > 0 ? [start, startLong] : [end, endLong]
    if (Math.abs(mx) > width * LONG_AT && long) return long
    return short
  }
  const stage = (mx: number, width: number) => (Math.abs(mx) > width * LONG_AT ? 2 : Math.abs(mx) > width * COMMIT_AT ? 1 : 0)

  return (
    <div
      ref={ref}
      className="relative touch-pan-y overflow-hidden select-none"
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return
        gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, swiping: false, armed: 0 }
        setW(e.currentTarget.offsetWidth || 360)
        setSettling(false)
      }}
      onPointerMove={(e) => {
        const g = gesture.current
        if (!g || g.id !== e.pointerId) return
        const mx = e.clientX - g.x
        const my = e.clientY - g.y
        if (!g.swiping) {
          if (Math.abs(my) > SLOP && Math.abs(my) > Math.abs(mx)) {
            gesture.current = null // a scroll; let it go
            return
          }
          if (Math.abs(mx) < SLOP) return
          g.swiping = true
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // Synthetic or already-released pointers can't be captured; the swipe still works.
          }
        }
        // A side with nothing to do stays put.
        if (!(mx > 0 ? start : end)) return
        const armed = stage(mx, width())
        if (armed !== g.armed) {
          g.armed = armed
          navigator.vibrate?.(8) // a tick as each stage arms or disarms
        }
        setDx(mx)
      }}
      onPointerUp={(e) => {
        const g = gesture.current
        gesture.current = null
        if (!g?.swiping) return
        swallowClick.current = true
        const mx = e.clientX - g.x
        const action = actionAt(mx, width())
        if (action && Math.abs(mx) > width() * COMMIT_AT) {
          setSettling(true)
          setDx(mx > 0 ? width() : -width())
          // Let the row finish sliding out, then act and spring back.
          window.setTimeout(() => {
            action.onCommit()
            setSettling(false)
            setDx(0)
          }, 160)
        } else {
          reset()
        }
      }}
      onPointerCancel={() => {
        gesture.current = null
        reset()
      }}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {dx !== 0 && actionAt(dx, w) && <Reveal action={actionAt(dx, w)!} side={dx > 0 ? "start" : "end"} armed={Math.abs(dx) > w * COMMIT_AT} />}
      <div
        className={cn("relative bg-surface-chrome", settling && "transition-transform duration-150 ease-out motion-reduce:transition-none")}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
      >
        {children}
      </div>
    </div>
  )
}

function Reveal({ action, side, armed }: { action: SwipeAction; side: "start" | "end"; armed: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute inset-0 flex items-center gap-2 px-6 text-sm font-medium text-white transition-opacity",
        action.tone,
        side === "start" ? "justify-start" : "justify-end",
        armed ? "opacity-100" : "opacity-70",
      )}
    >
      <Icon name={action.icon} fill={armed} className="size-6" opticalSize={24} />
      {action.label}
    </div>
  )
}
