import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Field, FieldDescription, FieldLabel, Icon, type IconName, Input, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, NativeSelect, NativeSelectOption, Spinner } from "@unicron/ui"
import { useAiModels, useAiSettings, useCore, useSetAiKey, useSetAiPrefs } from "@/core/queries"
import type { AiEndpoint, AiPrefs, AiProvider, AiSettings } from "@/core/types"

/** What each choice means, in the words the dialog uses. `remote`: the gateway, where "this computer" is the server. */
function choices(remote: boolean): { value: AiProvider; icon: IconName; title: string; hint: string }[] {
  return [
    { value: "off", icon: "block", title: "Off", hint: "Mailbird never sends your mail to a model." },
    remote
      ? { value: "local", icon: "dns", title: "On your own server", hint: "Ollama or similar, beside your gateway. Mail stays on your machines." }
      : { value: "local", icon: "computer", title: "On this computer", hint: "Ollama, LM Studio, or similar. Your mail stays on this computer." },
    { value: "anthropic", icon: "cloud", title: "Claude, with your API key", hint: "Anthropic's models. What you ask about goes to Anthropic." },
    { value: "compatible", icon: "api", title: "Another service, with your API key", hint: "Any OpenAI-style API. What you ask about goes there." },
  ]
}

/** Opt-in AI's settings (ADR-0059): where the model runs, which model, and its key. */
export function AiSettingsDialog() {
  const open = useUi((s) => s.aiSettingsOpen)
  const setOpen = useUi((s) => s.setAiSettingsOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>AI summaries and replies</DialogTitle>
          <DialogDescription>Off unless you turn it on. A conversation goes to the model only when you ask for its summary or replies.</DialogDescription>
        </DialogHeader>
        {open && <AiSettingsForm />}
      </DialogContent>
    </Dialog>
  )
}

function AiSettingsForm() {
  const { data: settings } = useAiSettings()
  const { data: core } = useCore()
  const set = useSetAiPrefs()
  if (!settings) return null
  const prefs = settings.prefs
  const save = (p: Partial<AiPrefs>, said?: string) => set.mutate({ ...prefs, ...p }, { onSuccess: () => said && toast.success(said, { duration: 2000 }), onError: (e) => toast.error(e.message) })
  const options = choices(!!core?.remote)

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-labelledby="ai-where">
        <h3 id="ai-where" className="text-sm font-medium">
          Where the model runs
        </h3>
        <div role="radiogroup" aria-labelledby="ai-where" className="flex flex-col gap-2">
          {options.map((o) => (
            <Item
              key={o.value}
              variant="outline"
              size="sm"
              data-selected={prefs.provider === o.value}
              render={<button type="button" role="radio" aria-checked={prefs.provider === o.value} onClick={() => prefs.provider !== o.value && save({ provider: o.value }, o.value === "off" ? "AI is off" : undefined)} />}
            >
              <ItemMedia variant="icon">
                <Icon name={o.icon} tone="muted" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{o.title}</ItemTitle>
                <ItemDescription>{o.hint}</ItemDescription>
              </ItemContent>
              {/* Hover and chosen share a background, so the chosen one also carries a check. */}
              {prefs.provider === o.value && (
                <ItemActions>
                  <Icon name="check_circle" fill />
                </ItemActions>
              )}
            </Item>
          ))}
        </div>
      </section>

      {prefs.provider === "local" && <LocalServer key="local" settings={settings} onSave={save} remote={!!core?.remote} />}
      {prefs.provider === "anthropic" && <Hosted key="anthropic" provider="anthropic" settings={settings} onSave={save} />}
      {prefs.provider === "compatible" && <Hosted key="compatible" provider="compatible" settings={settings} onSave={save} />}

      {prefs.provider !== "off" && (
        <p className="flex gap-2 text-xs text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
          <Icon name="info" />
          What's sent: the text of the one conversation you ask about, newest messages first. Never attachments, images, or other mail, and nothing is sent on its own.
        </p>
      )}
    </div>
  )
}

/** An address field that saves when you leave it. */
function AddressField({ id, label, value, hint, onSave }: { id: string; label: string; value: string; hint: string; onSave: (url: string) => void }) {
  const [text, setText] = useState(value)
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} inputMode="url" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== value && onSave(text)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  )
}

function LocalServer({ settings, onSave, remote }: { settings: AiSettings; onSave: (p: Partial<AiPrefs>, said?: string) => void; remote: boolean }) {
  const local = settings.prefs.local
  const setLocal = (e: Partial<AiEndpoint>, said?: string) => onSave({ local: { ...local, ...e } }, said)
  return (
    <section className="flex flex-col gap-4" aria-label="Model server">
      <AddressField
        id="ai-local-url"
        label="Server address"
        value={local.url}
        hint={`Ollama is at http://localhost:11434/v1 and LM Studio at http://localhost:1234/v1${remote ? ", as seen from the gateway" : ""}. Plain http works only on your own network.`}
        onSave={(url) => setLocal({ url })}
      />
      <ModelPicker provider="local" url={local.url} model={local.model} onPick={(model) => setLocal({ model }, `Using ${model}`)} empty="No models on this server yet. With Ollama, run “ollama pull llama3.2”, then try again." />
    </section>
  )
}

function Hosted({ provider, settings, onSave }: { provider: "anthropic" | "compatible"; settings: AiSettings; onSave: (p: Partial<AiPrefs>, said?: string) => void }) {
  const p = settings.prefs
  const hasKey = settings.keys[provider]
  const model = provider === "anthropic" ? p.anthropicModel : p.compatible.model
  const pick = (m: string) => onSave(provider === "anthropic" ? { anthropicModel: m } : { compatible: { ...p.compatible, model: m } }, `Using ${m}`)
  return (
    <section className="flex flex-col gap-4" aria-label={provider === "anthropic" ? "Claude" : "Service"}>
      {provider === "compatible" && (
        <AddressField id="ai-service-url" label="Service address" value={p.compatible.url} hint="Its OpenAI-style API, ending in /v1 for most services." onSave={(url) => onSave({ compatible: { ...p.compatible, url } })} />
      )}
      <KeyField provider={provider} saved={hasKey} />
      {hasKey && <ModelPicker provider={provider} url={provider === "compatible" ? p.compatible.url : undefined} model={model} onPick={pick} empty="This service lists no models that can chat." />}
    </section>
  )
}

/** A key goes in once and stays in the keychain: the dialog only ever knows that one is saved. */
function KeyField({ provider, saved }: { provider: "anthropic" | "compatible"; saved: boolean }) {
  const setKey = useSetAiKey()
  const [replacing, setReplacing] = useState(false)
  const [text, setText] = useState("")
  const { data: core } = useCore()
  const where = core?.remote ? "the gateway's sealed store" : "your system keychain"
  const id = `ai-key-${provider}`
  const submit = () =>
    setKey.mutate(
      { provider, key: text },
      {
        onSuccess: () => {
          setText("")
          setReplacing(false)
          toast.success("Key saved", { duration: 2000 })
        },
        onError: (e) => toast.error(e.message),
      },
    )

  if (saved && !replacing) {
    return (
      <Field>
        <FieldLabel>API key</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm [&_svg]:size-4 [&_svg]:text-vertical-mail-text">
            <Icon name="key" /> Saved in {where}
          </span>
          <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button variant="ghost-destructive" size="sm" onClick={() => setKey.mutate({ provider, key: null }, { onSuccess: () => toast.success("Key removed", { duration: 2000 }) })}>
            Remove
          </Button>
        </div>
      </Field>
    )
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) submit()
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>API key</FieldLabel>
        <div className="flex gap-2">
          <Input id={id} type="password" autoComplete="off" spellCheck={false} placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"} value={text} onChange={(e) => setText(e.target.value)} autoFocus={replacing} />
          <Button type="submit" disabled={!text.trim() || setKey.isPending}>
            Save
          </Button>
        </div>
        <FieldDescription>
          {provider === "anthropic" ? "Make one in the Claude Console, under API keys. " : ""}It's kept in {where}, never in Mailbird's database, and it isn't shown again.
        </FieldDescription>
      </Field>
      {replacing && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
            Keep the saved key
          </Button>
        </div>
      )}
    </form>
  )
}

/**
 * The models the server offers, asked of the server itself. It's also the
 * connection check: an answer means the address (and key) are right.
 */
function ModelPicker({ provider, url, model, onPick, empty }: { provider: AiProvider; url?: string; model: string; onPick: (m: string) => void; empty: string }) {
  const models = useAiModels(provider, true, url)
  const [typed, setTyped] = useState(model)
  const id = `ai-model-${provider}`

  if (models.isPending) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Checking the connection…
      </p>
    )
  }
  if (models.isError) {
    // Still let a model be typed: some servers don't list theirs.
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-destructive">
          <Icon name="error" />
          <span className="min-w-0 flex-1">{models.error.message}</span>
          <Button variant="outline" size="xs" onClick={() => void models.refetch()}>
            Try again
          </Button>
        </p>
        <Field>
          <FieldLabel htmlFor={id}>Model</FieldLabel>
          <Input id={id} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} onBlur={() => typed.trim() && typed.trim() !== model && onPick(typed.trim())} />
          <FieldDescription>Its name exactly as the server knows it.</FieldDescription>
        </Field>
      </div>
    )
  }
  const list = models.data
  if (!list.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  // A saved model the server no longer has still shows, so nothing changes behind your back.
  const shown = model && !list.includes(model) ? [model, ...list] : list
  return (
    <Field>
      <FieldLabel htmlFor={id}>Model</FieldLabel>
      <NativeSelect id={id} value={model} onChange={(e) => onPick(e.target.value)}>
        {!model && (
          <NativeSelectOption value="" disabled>
            Choose a model
          </NativeSelectOption>
        )}
        {shown.map((m) => (
          <NativeSelectOption key={m} value={m}>
            {m}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>Connected. {provider === "anthropic" ? "Opus is the most capable; Haiku is the fastest and costs least." : "Bigger models write better summaries; smaller ones answer sooner."}</FieldDescription>
    </Field>
  )
}
