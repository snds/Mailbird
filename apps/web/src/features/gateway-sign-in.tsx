import { useEffect, useState, type ReactNode } from "react"

import { Icon, Button, Field, FieldDescription, FieldLabel, Input } from "@unicron/ui"
import { SIGNED_OUT, gatewaySession, isTauri, joinGateway, signInToGateway } from "@/core/client"

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
  // An invitation to the team (ADR-0063): /join#<code>.
  if (location.pathname === "/join") return <Join />
  if (gate === "sign-in") return <SignIn />
  return children
}

function Frame({ children, onSubmit, intro }: { children: ReactNode; onSubmit: () => Promise<void>; intro: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-canvas px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-background p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault()
          void onSubmit()
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Icon name="mail" className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Mailbird</h1>
          <p className="text-sm text-muted-foreground">{intro}</p>
        </div>
        {children}
      </form>
    </main>
  )
}

/** Opening an invitation: choose a password, and you're in. */
function Join() {
  const code = location.hash.slice(1)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Frame
      intro="You've been invited to work on a shared inbox. Choose a password to sign in with."
      onSubmit={async () => {
        setBusy(true)
        setError(null)
        try {
          await joinGateway(code, password)
          // Into the app, and off the invitation's address.
          location.replace("/")
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setBusy(false)
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor="join-password">Choose a password</FieldLabel>
        <Input id="join-password" type="password" autoComplete="new-password" minLength={12} required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <FieldDescription>At least 12 characters. You'll sign in with your email and this password.</FieldDescription>
      </Field>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || password.length < 12 || !code}>
        Join
      </Button>
    </Frame>
  )
}

function SignIn() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Frame
      intro="Enter your email and password, or, if it's your gateway, just its password."
      onSubmit={async () => {
        setBusy(true)
        setError(null)
        try {
          await signInToGateway(password, email)
          // A fresh start, so every query and the event stream use the new session.
          location.reload()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setBusy(false)
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor="gateway-email">Email</FieldLabel>
        <Input id="gateway-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        <FieldDescription>If you were invited to the team. The gateway's owner leaves it empty.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="gateway-password">{email.trim() ? "Password" : "Gateway password"}</FieldLabel>
        <Input id="gateway-password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {!email.trim() && <FieldDescription>The GATEWAY_PASSWORD it was started with.</FieldDescription>}
      </Field>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !password}>
        Sign in
      </Button>
    </Frame>
  )
}
