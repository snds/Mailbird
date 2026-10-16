import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon, type IconName, Button, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldGroup, FieldLabel, Input, Spinner, DialogAction, DialogActions } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { OAuthClientInfo, OAuthIssuer } from "@/core/types"

interface ProviderCopy {
  title: string
  company: string
  grants: { icon: IconName; text: string }[]
  stays: string
  hintLabel: string
  hintPlaceholder: string
  hintHelp: string
  builtInWarning: string
  ownWarning: string
  noClient: string
  /** What the provider calls the app's registration. */
  clientNoun: string
  clientIdLabel: string
  clientIdPlaceholder: string
  clientIdHelp: string
  /** Google gives Desktop clients a secret; Microsoft public clients have none. */
  secret: boolean
  docs: string
}

const DOCS = "https://github.com/snds/Mailbird/blob/main/docs"

const COPY: Record<OAuthIssuer, ProviderCopy> = {
  google: {
    title: "Add Gmail",
    company: "Google",
    grants: [
      { icon: "mail", text: "Read, organize, and send your Gmail" },
      { icon: "calendar_month", text: "See and edit your Google Calendar" },
      { icon: "contacts", text: "See and edit your Google Contacts" },
    ],
    stays: "Everything stays on this device. Revoke access any time in your Google Account, or by removing the account here.",
    hintLabel: "Gmail address (optional)",
    hintPlaceholder: "you@gmail.com",
    hintHelp: "Picks the account on Google's page if you're signed in to several.",
    builtInWarning: "Until Google verifies this app, Google shows a warning page first. Continue only if you trust this copy of the app.",
    ownWarning: "Your own OAuth client is in testing mode, so Google shows a warning page and only allows the test users you added.",
    noClient: "This build has no Google sign-in set up. Google requires each app to register, so add your own OAuth client to sign in.",
    clientNoun: "OAuth client",
    clientIdLabel: "Client ID",
    clientIdPlaceholder: "…apps.googleusercontent.com",
    clientIdHelp: "In Google Cloud, create an OAuth client of type Desktop app and enable the Gmail, Calendar, and CardDAV APIs.",
    secret: true,
    docs: `${DOCS}/google-verification.md#use-your-own-oauth-client`,
  },
  microsoft: {
    title: "Add Outlook",
    company: "Microsoft",
    grants: [
      { icon: "mail", text: "Read, organize, and send your Outlook mail" },
      { icon: "calendar_month", text: "See and edit your Outlook calendars" },
      { icon: "contacts", text: "See and edit your Outlook contacts" },
    ],
    // Microsoft has no way for an app to revoke its own sign-in.
    stays: "Everything stays on this device. Removing the account here deletes its sign-in from this device; to revoke access everywhere, use the app permissions page of your Microsoft account.",
    hintLabel: "Microsoft account email (optional)",
    hintPlaceholder: "you@outlook.com",
    hintHelp: "Suggests this account on Microsoft's page.",
    builtInWarning: "Microsoft lists this app as unverified until its publisher is verified. Continue only if you trust this copy of the app.",
    ownWarning: "Microsoft asks you to approve your own app registration the first time. Work or school accounts may need an administrator to approve it.",
    noClient: "This build has no Microsoft sign-in set up. Microsoft requires each app to register, so add your own app registration to sign in.",
    clientNoun: "app registration",
    clientIdLabel: "Application (client) ID",
    clientIdPlaceholder: "00000000-0000-0000-0000-000000000000",
    clientIdHelp: "In the Microsoft Entra admin center, register an app for personal and work accounts, add the Mobile and desktop platform with the redirect http://localhost, and allow public client flows.",
    secret: false,
    docs: `${DOCS}/microsoft-setup.md`,
  },
}

/**
 * Adds a Google or Microsoft account by signing in on the provider's own
 * page, in the system browser. The app never sees the password; it gets
 * tokens it can refresh.
 */
export function OAuthSignIn({ issuer, onBack, onDone }: { issuer: OAuthIssuer; onBack: () => void; onDone: () => void }) {
  const copy = COPY[issuer]
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
        <DialogTitle>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => (signIn.isPending && cancel(), onBack())} aria-label="Back">
            <Icon name="arrow_back" />
          </Button>
          {copy.title}
        </DialogTitle>
        <DialogDescription>
          You'll sign in on {copy.company}'s page in your browser. This app never sees your {copy.company} password.
        </DialogDescription>
      </DialogHeader>

      {signIn.isPending ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/40 px-4 py-6 text-center" role="status" aria-live="polite">
          <Spinner className="size-6" />
          <p className="text-sm font-medium">Finish signing in in your browser</p>
          <p className="max-w-xs text-xs text-muted-foreground">When {copy.company} says you're signed in, come back here. The tab can be closed.</p>
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : needsClient ? (
        <ClientForm issuer={issuer} copy={copy} current={client ?? null} onClose={() => setEditing(false)} />
      ) : (
        <>
          <section aria-label="What the app can do" className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">{copy.company} will ask you to allow this app to:</p>
            <ul className="flex flex-col gap-1.5">
              {copy.grants.map((g) => (
                <li key={g.text} className="flex items-center gap-2 text-sm">
                  <Icon name={g.icon} tone="muted" className="size-4" /> {g.text}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{copy.stays}</p>
          </section>
          <Field>
            <FieldLabel htmlFor="oauth-hint">{copy.hintLabel}</FieldLabel>
            <Input id="oauth-hint" type="email" autoComplete="email" placeholder={copy.hintPlaceholder} value={hint} onChange={(e) => setHint(e.target.value)} />
            <FieldDescription>{copy.hintHelp}</FieldDescription>
          </Field>
          {signIn.error && (
            <p className="text-sm text-destructive" role="alert">
              {signIn.error instanceof Error ? signIn.error.message : String(signIn.error)}
            </p>
          )}
          <p className="flex gap-2 text-xs text-muted-foreground">
            <Icon name="info" className="mt-0.5 size-4" />
            {client?.builtIn ? copy.builtInWarning : copy.ownWarning}
          </p>
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setEditing(true)}>
              {client?.builtIn ? `Use your own ${copy.clientNoun}` : `Change ${copy.clientNoun}`}
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

function ClientForm({ issuer, copy, current, onClose }: { issuer: OAuthIssuer; copy: ProviderCopy; current: OAuthClientInfo | null; onClose: () => void }) {
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
          <Icon name="key" className="mt-0.5 size-4" />
          {copy.noClient}
        </p>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="oauth-client-id">{copy.clientIdLabel}</FieldLabel>
          <Input id="oauth-client-id" required autoComplete="off" placeholder={copy.clientIdPlaceholder} value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <FieldDescription>
            {copy.clientIdHelp}{" "}
            <a href={copy.docs} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Step-by-step guide
            </a>
          </FieldDescription>
        </Field>
        {copy.secret && (
          <Field>
            <FieldLabel htmlFor="oauth-client-secret">Client secret</FieldLabel>
            <Input id="oauth-client-secret" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <FieldDescription>Google gives Desktop clients one and asks for it at sign-in. In an installed app it isn't a real secret; it's kept on this device.</FieldDescription>
          </Field>
        )}
      </FieldGroup>
      <DialogActions>
        {current && !current.builtIn && (
          <DialogAction kind="destructive" type="button" onClick={() => save.mutate(null)}>
            Remove saved {copy.clientNoun}
          </DialogAction>
        )}
        {current && (
          <DialogAction kind="cancel" type="button" onClick={onClose}>
            Cancel
          </DialogAction>
        )}
        <DialogAction type="submit" disabled={!clientId.trim() || save.isPending}>
          Save {copy.clientNoun}
        </DialogAction>
      </DialogActions>
    </form>
  )
}
