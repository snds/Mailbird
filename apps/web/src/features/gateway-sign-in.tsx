import { useEffect, useState, type ReactNode } from "react"

import { Icon, Button, Field, FieldDescription, FieldLabel, Input } from "@unicron/ui"
import { SIGNED_OUT, gatewaySession, isTauri, signInToGateway } from "@/core/client"

type Gate = "checking" | "open" | "sign-in"

/**
 * In front of the app when it's served by a web gateway (ADR-0016): the
 * gateway holds your accounts, so it asks for its password first. On the
 * desktop and phone apps, and the demo, this renders the app straight away.
 */
export function GatewayGate({ children }: { children: ReactNode }) {
  // The desktop and phone apps never sit behind a gateway.
  const [gate, setGate] = useState<Gate>(() => (isTauri() ? "open" : "checking"))
  useEffect(() => {
    if (isTauri()) return
    void gatewaySession().then((s) => setGate(s && !s.signedIn ? "sign-in" : "open"))
    const out = () => setGate("sign-in")
    window.addEventListener(SIGNED_OUT, out)
    return () => window.removeEventListener(SIGNED_OUT, out)
  }, [])
  if (gate === "checking") return null
  if (gate === "sign-in") return <SignIn />
  return children
}

function SignIn() {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-canvas px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-background p-6 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await signInToGateway(password)
            // A fresh start, so every query and the event stream use the new session.
            location.reload()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            setBusy(false)
          }
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Icon name="mail" className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Mailbird</h1>
          <p className="text-sm text-muted-foreground">This is your own gateway. Enter its password to open your mail.</p>
        </div>
        <Field>
          <FieldLabel htmlFor="gateway-password">Gateway password</FieldLabel>
          <Input id="gateway-password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <FieldDescription>The GATEWAY_PASSWORD it was started with.</FieldDescription>
        </Field>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !password}>
          Sign in
        </Button>
      </form>
    </main>
  )
}
