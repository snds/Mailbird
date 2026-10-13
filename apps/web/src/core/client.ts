import type {
  Account,
  AccountConfig,
  Capabilities,
  Draft,
  MessageDetail,
  MessageQuery,
  MessageSummary,
  OutboxItem,
  Provider,
} from "./types"

/**
 * The one API the UI uses to reach the core, whatever the shell.
 * - Tauri (desktop now, mobile next): IPC into the Rust core in-process.
 * - Browser: an in-memory demo until the self-hosted gateway exists (ADR-0002).
 */
export interface CoreClient {
  /** "native" can connect real accounts; "demo" runs on sample data. */
  readonly kind: "native" | "demo"
  providerCapabilities(provider: Provider): Promise<Capabilities>
  listAccounts(): Promise<Account[]>
  addAccount(config: AccountConfig, password: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  syncNow(): Promise<void>
  listMessages(query: MessageQuery): Promise<MessageSummary[]>
  getMessage(id: string): Promise<MessageDetail>
  setSeen(id: string, seen: boolean): Promise<void>
  setFlagged(id: string, flagged: boolean): Promise<void>
  setArchived(id: string, archived: boolean): Promise<void>
  snooze(id: string, until: number): Promise<void>
  unsnooze(id: string): Promise<void>
  queueSend(draft: Draft, undoSecs: number): Promise<OutboxItem>
  cancelSend(id: string): Promise<Draft>
  listOutbox(): Promise<OutboxItem[]>
  /** Subscribe to core change events; returns an unsubscribe function. */
  on(event: CoreEvent, handler: (payload?: unknown) => void): () => void
}

export type CoreEvent = "mail:changed" | "outbox:changed" | "accounts:changed"

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

async function createTauriClient(): Promise<CoreClient> {
  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")
  // Tauri maps camelCase argument names to the Rust commands' snake_case.
  return {
    kind: "native",
    providerCapabilities: (provider) => invoke("provider_capabilities", { provider }),
    listAccounts: () => invoke("list_accounts"),
    addAccount: (config, password) => invoke("add_account", { config, password }),
    removeAccount: (id) => invoke("remove_account", { id }),
    syncNow: () => invoke("sync_now"),
    listMessages: (query) => invoke("list_messages", { query }),
    getMessage: (id) => invoke("get_message", { id }),
    setSeen: (id, seen) => invoke("set_seen", { id, seen }),
    setFlagged: (id, flagged) => invoke("set_flagged", { id, flagged }),
    setArchived: (id, archived) => invoke("set_archived", { id, archived }),
    snooze: (id, until) => invoke("snooze", { id, until }),
    unsnooze: (id) => invoke("unsnooze", { id }),
    queueSend: (draft, undoSecs) => invoke("queue_send", { draft, undoSecs }),
    cancelSend: (id) => invoke("cancel_send", { id }),
    listOutbox: () => invoke("list_outbox"),
    on(event, handler) {
      let off: (() => void) | undefined
      let cancelled = false
      void listen(event, (e) => handler(e.payload)).then((unlisten) => {
        if (cancelled) unlisten()
        else off = unlisten
      })
      return () => {
        cancelled = true
        off?.()
      }
    },
  }
}

let clientPromise: Promise<CoreClient> | null = null

export function getCoreClient(): Promise<CoreClient> {
  clientPromise ??= isTauri()
    ? createTauriClient()
    : import("./demo").then((m) => m.createDemoClient())
  return clientPromise
}
