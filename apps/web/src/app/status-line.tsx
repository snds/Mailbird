import { AppFrameStatusLine, StatusItem, type AppFrameCrumb } from "@unicron/ui"

import { useScreen } from "./screen"

/**
 * The desktop's top line (ADR-0083): where you are at the start, as
 * SECTION // PLACE with every part but the last a way back, and the screen's
 * own fact at the end. The view sets the place and the fact (`useScreenPlace`,
 * `useScreenFact`). At medium width the frame puts a pushed detail's back
 * button in the leading slot by itself.
 */
export function StatusLine({ section, onSection }: { section: string; onSection: () => void }) {
  const place = useScreen((s) => s.place)
  const fact = useScreen((s) => s.fact)
  const crumbs: AppFrameCrumb[] = place && place !== section ? [{ label: section, onClick: onSection }, { label: place }] : [{ label: section }]
  return <AppFrameStatusLine crumbs={crumbs}>{fact && <StatusItem text={fact} />}</AppFrameStatusLine>
}
