import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { getCoreClient, type CoreClient } from "./client"
import type { MessageQuery } from "./types"

export const queryClient = new QueryClient({
  defaultOptions: {
    // The core pushes change events, so polling and refetch-on-focus are unnecessary.
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
})

const keys = {
  core: ["core"] as const,
  accounts: ["accounts"] as const,
  messages: (q: MessageQuery) => ["messages", q] as const,
  message: (id: string) => ["message", id] as const,
  outbox: ["outbox"] as const,
}

export function useCore() {
  return useQuery({ queryKey: keys.core, queryFn: getCoreClient })
}

async function call<T>(fn: (c: CoreClient) => Promise<T>) {
  return fn(await getCoreClient())
}

/** Wire core change events to cache invalidation. Mount once near the root. */
export function useCoreEvents() {
  const qc = useQueryClient()
  const { data: core } = useCore()
  useEffect(() => {
    if (!core) return
    const offs = [
      core.on("mail:changed", () => {
        void qc.invalidateQueries({ queryKey: ["messages"] })
        void qc.invalidateQueries({ queryKey: ["message"] })
      }),
      core.on("outbox:changed", () => void qc.invalidateQueries({ queryKey: keys.outbox })),
      core.on("accounts:changed", () => void qc.invalidateQueries({ queryKey: keys.accounts })),
    ]
    return () => offs.forEach((off) => off())
  }, [core, qc])
}

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: () => call((c) => c.listAccounts()) })
}

export function useMessages(q: MessageQuery) {
  return useQuery({
    queryKey: keys.messages(q),
    queryFn: () => call((c) => c.listMessages(q)),
    placeholderData: (prev) => prev, // keep the list on screen while a search refines
  })
}

export function useMessage(id: string | null) {
  return useQuery({
    queryKey: keys.message(id ?? ""),
    queryFn: () => call((c) => c.getMessage(id!)),
    enabled: id !== null,
  })
}

export function useOutbox() {
  return useQuery({ queryKey: keys.outbox, queryFn: () => call((c) => c.listOutbox()) })
}

/** A mutation that refreshes mail lists afterwards. */
export function useMailAction<A>(fn: (c: CoreClient, args: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => call((c) => fn(c, args)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["messages"] })
      void qc.invalidateQueries({ queryKey: ["message"] })
    },
  })
}
