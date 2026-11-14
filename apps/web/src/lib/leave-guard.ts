import { createContext, useContext, useEffect, useRef } from "react"
import { create, type StateCreator } from "zustand"

/**
 * Forms ask before they drop writing (ADR-0087; brief X6): "Discard
 * changes?", DISCARD and KEEP EDITING, focus on KEEP EDITING.
 *
 * A form says what it holds with `useLeaveGuard`. Where it stands decides
 * who asks:
 *
 * - **In the form layer** (`components/editor-frame.tsx`): the layer asks
 *   when it is closed by Esc, its close button or Cancel.
 * - **In the pane** (a contact edited in the detail column, a task's Plan):
 *   every move away asks. The places store is wrapped with `guardPlaces`, so
 *   a place change, a jump, a toast's OPEN, a section switch, Search and
 *   Settings all wait for the answer. A move the store does not see (another
 *   row, a key that moves rows) goes through `leaveThen` by the view that
 *   makes it.
 */
export interface LeaveGuard {
  /** Whether the form holds anything to lose, asked at the moment of leaving. */
  dirty: () => boolean
  /** In the pane: closes the form once the answer is DISCARD, before the move is made. */
  discard?: () => void
}

/** The form layer's own guard: the form inside it registers, the layer asks it when it is closed. */
export interface LayerGuard {
  register: (guard: LeaveGuard) => () => void
  dirty: () => boolean
}
export function createLayerGuard(): LayerGuard {
  let held: LeaveGuard | null = null
  return {
    register: (guard) => {
      held = guard
      return () => {
        if (held === guard) held = null
      }
    },
    dirty: () => held?.dirty() ?? false,
  }
}
export const LayerGuardContext = createContext<LayerGuard | null>(null)

/** The forms in the pane that are open now. */
const panes = new Set<LeaveGuard>()
/** Set while a move that was answered with DISCARD is made, so it is not asked about again. */
let passing = false

interface LeaveQuestion {
  /** The move that waits for an answer, or null. `LeaveQuestion` (mounted once at the root) asks while it is set. */
  pending: (() => void) | null
}
export const useLeaveQuestion = create<LeaveQuestion>(() => ({ pending: null }))

/**
 * Registers a form's unsaved writing while it is mounted. `dirty` is a
 * value, or a function read at the moment of leaving (for writing that does
 * not re-render the form, such as an editor's text). `discard` is for a form
 * in the pane: it closes the form.
 */
export function useLeaveGuard(dirty: boolean | (() => boolean), discard?: () => void) {
  const layer = useContext(LayerGuardContext)
  const latest = useRef({ dirty, discard })
  useEffect(() => {
    latest.current = { dirty, discard }
  })
  useEffect(() => {
    const guard: LeaveGuard = {
      dirty: () => {
        const d = latest.current.dirty
        return typeof d === "function" ? d() : d
      },
      discard: () => latest.current.discard?.(),
    }
    if (layer) return layer.register(guard)
    panes.add(guard)
    return () => {
      panes.delete(guard)
    }
  }, [layer])
}

/** Whether a form in the pane holds unsaved writing right now. */
export const paneHoldsWriting = () => [...panes].some((g) => g.dirty())

/**
 * Makes a move away from the pane: at once when no form in it holds
 * writing; otherwise after DISCARD, and not at all after KEEP EDITING. Moves
 * asked for while the question is open join it, in order.
 */
export function leaveThen(run: () => void) {
  if (passing) return run()
  const held = [...panes].filter((g) => g.dirty())
  const waiting = useLeaveQuestion.getState().pending
  if (!held.length && !waiting) return run()
  useLeaveQuestion.setState({
    pending: () => {
      waiting?.()
      for (const g of held) g.discard?.()
      run()
    },
  })
}

/** The answer to the pane's question: DISCARD makes the move, KEEP EDITING forgets it. */
export function answerLeave(discard: boolean) {
  const { pending } = useLeaveQuestion.getState()
  useLeaveQuestion.setState({ pending: null })
  if (!discard || !pending) return
  passing = true
  try {
    pending()
  } finally {
    passing = false
  }
}

/**
 * Wraps a store's creator so that a change that moves away (`moves`) waits
 * for the pane's question while a form there holds writing. Every other
 * change, and every change while no form is open in the pane, goes straight
 * through.
 */
export function guardPlaces<T extends object>(moves: (next: T, prev: T) => boolean, creator: StateCreator<T>): StateCreator<T> {
  return (set, get, api) => {
    const apply = set as (partial: unknown, replace?: boolean) => void
    const guarded = (partial: unknown, replace?: boolean) => {
      if (passing || panes.size === 0) return apply(partial, replace)
      const prev = get()
      const patch = typeof partial === "function" ? (partial as (s: T) => Partial<T>)(prev) : (partial as Partial<T>)
      if (!moves({ ...prev, ...patch }, prev)) return apply(patch, replace)
      // Worked out again when it is made: the store may have changed while the question stood.
      leaveThen(() => apply(partial, replace))
    }
    api.setState = guarded as typeof api.setState
    return creator(guarded as typeof set, get, api)
  }
}
