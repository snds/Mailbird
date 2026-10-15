import { create } from "zustand"

import type { Sketch } from "@/lib/sketch"

/** Which sketch is open, if any: a new one, or one already in the note (by its position). */
export const useSketchSheet = create<{ open: null | { sketch: Sketch | null; pos: number | null }; show: (sketch: Sketch | null, pos: number | null) => void; close: () => void }>(
  (set) => ({
    open: null,
    show: (sketch, pos) => set({ open: { sketch, pos } }),
    close: () => set({ open: null }),
  }),
)
