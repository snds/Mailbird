import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon, type IconName } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { getCoreClient } from "@/core/client"
import type { OAuthClientInfo, OAuthIssuer } from "@/core/types"

const GRANTS: { icon: IconName; text: string }[] = [
  { icon: "mail", text: "Read, organize, and send your Gmail" },
  { icon: "calendar_month", text: "See and edit your Google Calendar" },
  { icon: "contacts", text: "See and edit your Google Contacts" },
]

const SETUP_DOCS = "https://github.com/snds/Mailbird/blob/main/docs/google-verification.md#use-your-own-oauth-client"

/**
 * Adds a Google account by signing in on Google's own page, in the system
 * browser. The app never sees the password; it gets tokens it can refresh
 * and that you can revoke from your Google Account at any time.
 */
export function GoogleSignIn({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const issuer: OAuthIssuer = "google"
  const qc = useQueryClient()
  const { data: client, isPending } = useQuery({ queryKey: ["oauth-client", issuer], queryFn: async () => (await getCoreClient()).getOAuthClient(issuer) })
  const [editing, setEditing] = useState(false)
  const [hint, setHint] = useState("")

  const signIn = useMutation({
    mutationFn: async () => (await getCoreClient()).addOAuthAccount(issuer, hint.trim() || null),
    onSuccess: (a) => {
      void qc.invalidateQueries()
      toast.success(`${a.address} added — fetching mail, calendars, and contacts`)
      onDone()
    },
  })
  const cancel = () => void getCoreClient().then((c) => c.cancelOAuthSignIn())
  const needsClient = !isPending && (!client || editing)

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => (signIn.isPending && cancel(), onBack())} aria-label="Back">
            <Icon name="arrow_back" />
          </Button>
          Add Gmail
        </DialogTitle>
        <DialogDescription>You'll sign in on Google's page in your browser. This app never sees your Google password.</DialogDescription>
      </DialogHeader>

      {signIn.isPending ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/40 px-4 py-6 text-center" role="status" aria-live="polite">
          <Spinner className="size-6" />
          <p className="text-sm font-medium">Finish signing in in your browser</p>
          <p className="max-w-xs text-xs text-muted-foreground">When Google says you're signed in, come back here. The tab can be closed.</p>
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : needsClient ? (
        <ClientForm issuer={issuer} current={client ?? null} onClose={() => setEditing(false)} />
      ) : (
        <>
          <section aria-label="What the app can do" className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">Google will ask you to allow this app to:</p>
            <ul className="flex flex-col gap-1.5">
              {GRANTS.map((g) => (
                <li key={g.text} className="flex items-center gap-2 text-sm">
                  <Icon name={g.icon} className="size-4 text-muted-foreground" /> {g.text}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Everything stays on this device. Revoke access any time in your Google Account, or by removing the account here.</p>
          </section>
          <Field>
            <FieldLabel htmlFor="oauth-hint">Gmail address (optional)</FieldLabel>
            <Input id="oauth-hint" type="email" autoComplete="email" placeholder="you@gmail.com" value={hint} onChange={(e) => setHint(e.target.value)} />
            <FieldDescription>Picks the account on Google's page if you're signed in to several.</FieldDescription>
          </Field>
          {signIn.error && (
            <p className="text-sm text-destructive" role="alert">
              {signIn.error instanceof Error ? signIn.error.message : String(signIn.error)}
            </p>
          )}
          <p className="flex gap-2 text-xs text-muted-foreground">
            <Icon name="info" className="mt-0.5 size-4 shrink-0" />
            {client?.builtIn
              ? "Until Google verifies this app, Google shows a warning page first. Continue only if you trust this copy of the app."
              : "Your own OAuth client is in testing mode, so Google shows a warning page and only allows the test users you added."}
          </p>
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setEditing(true)}>
              {client?.builtIn ? "Use your own OAuth client" : "Change OAuth client"}
            </Button>
            <Button onClick={() => signIn.mutate()}>
              <Icon name="open_in_new" data-icon="inline-start" /> Continue in browser
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  )
}

function ClientForm({ issuer, current, onClose }: { issuer: OAuthIssuer; current: OAuthClientInfo | null; onClose: () => void }) {
  const [clientId, setClientId] = useState("")
  const [secret, setSecret] = useState("")
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: async (value: { clientId: string; clientSecret: string | null } | null) => (await getCoreClient()).setOAuthClient(issuer, value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oauth-client", issuer] })
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), save.mutate({ clientId: clientId.trim(), clientSecret: secret.trim() || null }))}>
      {!current && (
        <p className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-sm" role="status">
          <Icon name="key" className="mt-0.5 size-4 shrink-0" />
          This build has no Google sign-in set up. Google requires each app to register, so add your own OAuth client to sign in.
        </p>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="oauth-client-id">Client ID</FieldLabel>
          <Input id="oauth-client-id" required autoComplete="off" placeholder="…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <FieldDescription>
            In Google Cloud, create an OAuth client of type <strong>Desktop app</strong> and enable the Gmail, Calendar, and CardDAV APIs.{" "}
            <a href={SETUP_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Step-by-step guide
            </a>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="oauth-client-secret">Client secret</FieldLabel>
          <Input id="oauth-client-secret" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <FieldDescription>Google gives Desktop clients one and asks for it at sign-in. In an installed app it isn't a real secret; it's kept on this device.</FieldDescription>
        </Field>
      </FieldGroup>
      <DialogFooter className="items-center sm:justify-between">
        {current && !current.builtIn ? (
          <Button type="button" variant="link" size="sm" className="px-0 text-destructive" onClick={() => save.mutate(null)}>
            Remove saved client
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {current && (
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={!clientId.trim() || save.isPending}>
            Save client
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}
