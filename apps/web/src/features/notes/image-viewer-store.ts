import { create } from "zustand"

/** One of a note's images, as the viewer pages through them. */
export interface ViewerImage {
  id: string
  alt: string
}

/**
 * A note's images full screen (ADR-0067): opened from an image, with the
 * note's other images a swipe or an arrow key away.
 */
export const useImageViewer = create<{ images: ViewerImage[]; at: number; show: (images: ViewerImage[], at: number) => void; close: () => void }>((set) => ({
  images: [],
  at: 0,
  show: (images, at) => set({ images, at }),
  close: () => set({ images: [] }),
}))
