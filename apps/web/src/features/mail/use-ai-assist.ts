import { useMutation } from "@tanstack/react-query"

import { getCoreClient } from "@/core/client"
import type { AiProvider } from "@/core/types"

/** Where the answer came from, in a few words: the model, and whose machine. */
export function byline(provider: AiProvider, model: string) {
  const where = provider === "local" ? "on your model server" : provider === "anthropic" ? "at Anthropic" : "at your AI service"
  return `${model} ${where}`
}

const ask = <T,>(fn: (c: Awaited<ReturnType<typeof getCoreClient>>) => Promise<T>) => getCoreClient().then(fn)

/** A conversation's summary, asked for once (ADR-0059). Nothing is sent until `run`. */
export function useThreadSummary(threadId: string) {
  return useMutation({ mutationKey: ["ai", "summary", threadId], mutationFn: () => ask((c) => c.summarizeThread(threadId)) })
}

export function useSuggestedReplies(threadId: string) {
  return useMutation({ mutationKey: ["ai", "replies", threadId], mutationFn: () => ask((c) => c.suggestReplies(threadId)) })
}
