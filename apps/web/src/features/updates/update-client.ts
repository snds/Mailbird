import { isTauri } from "@/core/client"

/** Where an update stands (the update kit's `UpdateState`). */
export type UpdateState = "idle" | "checking" | "up_to_date" | "downloading" | "ready" | "available" | "failed"

/**
 * Where updates stand, from the desktop shell (the update kit's
 * `UpdateStatus`, apps/web/src-tauri/src/updater.rs). Plain data and plain
 * words; nothing in it is secret.
 */
export interface UpdateStatus {
  /** The running version, `0.1.0-main.20261108093000`. */
  version: string
  channel: "main" | "stable" | "local"
  /** Whether this build checks for updates at all. */
  enabled: boolean
  /** Why it doesn't, in one line. */
  off: string | null
  /** The "Check for updates automatically" switch. */
  auto_check: boolean
  state: UpdateState
  /** 0 to 99 while downloading. */
  percent: number | null
  /** The newer version (downloading, ready, available). */
  offered: string | null
  /** What went wrong, in plain words (failed). */
  error: string | null
  /** The download page (available). */
  link: string | null
  /** Why Vale points there instead of updating itself (available). */
  link_why: string | null
  /** The last check was asked for (the button or the menu). */
  asked: boolean
}

/** The window event every change arrives on. */
export const UPDATE_EVENT = "vale://update"

/**
 * The update kit's five commands, the release page, and the kit's event. They're the shell's own,
 * beside `core`: the web app, the gateway and Vale Demo have no updater.
 */
export interface UpdateClient {
  status(): Promise<UpdateStatus>
  /** Checks now and starts the download; the outcome arrives through `onStatus`. */
  check(): Promise<UpdateStatus>
  /** Installs the downloaded update and opens Vale again. */
  restart(): Promise<void>
  /** The "Check for updates automatically" switch. */
  setAuto(on: boolean): Promise<UpdateStatus>
  /** Closes Vale and opens it again (installing a downloaded update on the way). */
  reload(): Promise<void>
  /** Opens the release page the status names (`available`). */
  openPage(): Promise<void>
  /** Every change; returns the unsubscribe. */
  onStatus(handler: (s: UpdateStatus) => void): () => void
}

let client: Promise<UpdateClient> | null = null

/** The desktop's update client; null anywhere else (`isTauri` is false in the web app and Vale Demo). */
export function updateClient(): Promise<UpdateClient> | null {
  if (!isTauri()) return null
  client ??= (async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { listen } = await import("@tauri-apps/api/event")
    return {
      status: () => invoke<UpdateStatus>("update_status"),
      check: () => invoke<UpdateStatus>("update_check"),
      restart: () => invoke<void>("update_restart"),
      setAuto: (on) => invoke<UpdateStatus>("update_auto_set", { on }),
      reload: () => invoke<void>("app_reload"),
      openPage: () => invoke<void>("update_open_page"),
      onStatus(handler) {
        let off: (() => void) | undefined
        let cancelled = false
        void listen<UpdateStatus>(UPDATE_EVENT, (e) => handler(e.payload)).then((unlisten) => {
          if (cancelled) unlisten()
          else off = unlisten
        })
        return () => {
          cancelled = true
          off?.()
        }
      },
    }
  })()
  return client
}

/** Runs one update action; errors come back as plain words. */
export async function withUpdates<T>(fn: (c: UpdateClient) => Promise<T>): Promise<T> {
  const c = updateClient()
  if (!c) throw new Error("Updates are only in the desktop app.")
  return fn(await c)
}
