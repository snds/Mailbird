import type { ReactNode } from "react"

/**
 * Stands between the gateway's door and the app (ADR-0083). First run will
 * live here: the steps a new person takes before the shell shows, in the
 * focus frame (brief X8). Until that lane builds them it passes the app
 * through, and Mail's own empty state still says "Add your first account."
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  return children
}
