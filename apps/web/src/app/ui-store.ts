import { create } from "zustand"

import type { Draft } from "@/core/types"

/** App-level UI state that crosses views (composer, settings). */
interface UiState {
  /** A draft being written, or null when the composer is closed. */
  composer: Partial<Draft> | null
  openComposer: (draft?: Partial<Draft>) => void
  closeComposer: () => void
  accountsOpen: boolean
  setAccountsOpen: (open: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  composer: null,
  openComposer: (draft = {}) => set({ composer: draft }),
  closeComposer: () => set({ composer: null }),
  accountsOpen: false,
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
}))
