import type { ReactNode } from "react"
import { Banner, Button, EmptyState } from "@unicron/ui"

interface LoadStateProps {
  /** The place, as a sentence names it: "the Inbox", "your contacts". */
  place: string
  /** The place as an overline, for the empty form: "Inbox". */
  overline?: string
  /** The failed read's error, or null when the read is fine. */
  error: unknown
  /** There is a last good list to keep showing. */
  hasData: boolean
  /** Reads again. */
  onRetry: () => void
  retrying?: boolean
  /** The list as it is: shown as it is when nothing failed, and kept under the banner when a read failed. */
  children: ReactNode
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A list whose read can fail (ADR-0086; brief 4.0, cross-app decisions §9).
 * A failed read with a last good list keeps the list under a critical banner
 * with "Try again". With nothing to show, the critical empty state says
 * "Can't load {place}." with the server's words and "Try again". Loading and
 * the ordinary empty state stay the list's own.
 */
export function LoadState({ place, overline, error, hasData, onRetry, retrying, children }: LoadStateProps) {
  if (!error) return <>{children}</>
  if (!hasData) {
    return (
      <EmptyState
        tone="critical"
        overline={overline}
        title={`Can’t load ${place}.`}
        body={words(error)}
        action={
          <Button variant="secondary" loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )
  }
  return (
    <>
      <div data-role="load-error" className="px-4 pb-4">
        <Banner
          tone="critical"
          title={`Couldn’t load ${place}`}
          body={words(error)}
          action={
            <Button variant="secondary" size="sm" loading={retrying} onClick={onRetry}>
              Try again
            </Button>
          }
        />
      </div>
      {children}
    </>
  )
}
