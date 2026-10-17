import type { AiPrefs, AiProvider, AiSettings, MessageDetail, SuggestedReplies, ThreadSummary } from "./types"

/**
 * Opt-in AI in the demo (ADR-0059). There's no model here, so it answers the
 * way a careful one would, from the thread itself: the first sentence of each
 * message as the summary, and three stock replies. It says it's the demo.
 */
export function createDemoAi(thread: (threadId: string) => MessageDetail[], later: <T>(v: T) => Promise<T>) {
  let prefs: AiPrefs = { provider: "off", local: { url: "http://localhost:11434/v1", model: "" }, anthropicModel: "claude-opus-5-5", compatible: { url: "https://api.openai.com/v1", model: "" } }
  const keys = { local: false, anthropic: false, compatible: false }
  const settings = (): AiSettings => ({ prefs: structuredClone(prefs), keys: { ...keys } })

  const near = (url: string) => {
    const m = /^http:\/\/(\[[^\]]+\]|[^/:?]+)/i.exec(url)
    if (!m) return true
    const host = m[1]!.replace(/^\[|\]$/g, "").toLowerCase()
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(host) || /\.(local|lan|localhost)$/.test(host)
  }
  const ready = () => {
    const p = prefs
    if (p.provider === "off") throw new Error("AI is off. Turn it on in Settings → AI summaries and replies.")
    const model = p.provider === "local" ? p.local.model : p.provider === "anthropic" ? p.anthropicModel : p.compatible.model
    if (!model) throw new Error("Pick a model in Settings → AI summaries and replies.")
    if (p.provider !== "local" && !keys[p.provider]) throw new Error("the server rejected the sign-in: add your API key in Settings → AI summaries and replies")
    return { provider: p.provider, model }
  }
  const messages = (threadId: string) => {
    const list = thread(threadId).sort((a, b) => a.date - b.date)
    if (!list.length) throw new Error("This conversation is no longer here.")
    return list
  }
  const firstName = (m: MessageDetail) => (m.from.name ?? m.from.email).split(/[\s@]/)[0]!
  const ownWords = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith(">")).join(" ").split(/\bOn .+ wrote:/)[0]!.replace(/\s+/g, " ").trim()

  return {
    aiSettings: async () => later(settings()),
    setAiPrefs: async (p: AiPrefs) => {
      const tidy = (e: AiPrefs["local"], fallback: string) => ({ url: e.url.trim().replace(/\/+$/, "") || fallback, model: e.model.trim() })
      const next: AiPrefs = { provider: p.provider, local: tidy(p.local, "http://localhost:11434/v1"), anthropicModel: p.anthropicModel.trim() || "claude-opus-5-5", compatible: tidy(p.compatible, "https://api.openai.com/v1") }
      const inUse = next.provider === "local" ? next.local.url : next.provider === "compatible" ? next.compatible.url : null
      if (inUse !== null) {
        if (!/^https?:\/\/[^/]/i.test(inUse)) throw new Error(`“${inUse}” isn't a web address`)
        if (!near(inUse))
          throw new Error(next.provider === "local" ? "A model server off this network needs an https:// address, so nobody along the way can read your mail." : "This service needs an https:// address, so nobody along the way can read your mail.")
      }
      prefs = next
      return later(settings())
    },
    setAiKey: async (provider: AiProvider, key: string | null) => {
      if (provider === "off") throw new Error("this choice has no key")
      keys[provider] = !!key?.trim()
      return later(settings())
    },
    aiModels: async (provider: AiProvider) => {
      if (provider !== "local" && provider !== "off" && !keys[provider]) throw new Error("Add your API key first.")
      const list: Record<AiProvider, string[]> = { off: [], local: ["llama3.2", "qwen3:8b"], anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], compatible: ["demo-model"] }
      return later(list[provider])
    },
    summarizeThread: async (threadId: string): Promise<ThreadSummary> => {
      const { provider, model } = ready()
      const list = messages(threadId)
      const used = list.slice(-6)
      const points = used.map((m) => {
        const words = ownWords(m.bodyText)
        const sentence = /^.*?[.!?](\s|$)/.exec(words)?.[0]?.trim() ?? words.slice(0, 140)
        return `${m.mailbox === "Sent" ? "You" : firstName(m)}: ${sentence || "(no text)"}`
      })
      return new Promise((r) => setTimeout(() => r({ points, used: used.length, total: list.length, provider, model: `${model} (demo)` }), 400))
    },
    suggestReplies: async (threadId: string): Promise<SuggestedReplies> => {
      const { provider, model } = ready()
      const last = messages(threadId).findLast((m) => m.mailbox !== "Sent") ?? messages(threadId).at(-1)!
      const name = firstName(last)
      const replies = [`Thanks, ${name}. That works for me.`, `Thanks, ${name}. I can't make that work, but could we find another option?`, `Thanks, ${name}. Let me check and get back to you by tomorrow.`]
      return new Promise((r) => setTimeout(() => r({ replies, provider, model: `${model} (demo)` }), 400))
    },
  }
}
