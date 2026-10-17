import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Button, Icon, DialogDescription, DialogHeader, DialogTitle, Field, FieldLabel, IconButton, Input, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@unicron/ui"
import { useUi } from "@/app/ui-store"
import { type Invitation, addTeamMember, invitationUrl, reinviteTeamMember, removeTeamMember } from "@/core/client"
import { useTeamMembers } from "@/core/queries"

/**
 * The gateway's team (ADR-0063), for its owner: add someone and send them
 * their invitation link, send a new one, or take them off. Members work the
 * mail with you: assign conversations and leave each other notes.
 */
export function TeamMembersView() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <IconButton icon="arrow_back" label="Back to settings" variant="ghost" size="icon-sm" onClick={() => (useUi.getState().setMembersOpen(false), useUi.getState().setAccountsOpen(true))} />
          Team members
        </DialogTitle>
        <DialogDescription>People you add work this gateway's mail with you: they read and reply from its accounts, assign conversations, and leave each other notes. Your accounts, settings, calendars, contacts, and notes stay yours.</DialogDescription>
      </DialogHeader>
      <Members />
    </>
  )
}

function Members() {
  const { data: members = [] } = useTeamMembers()
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [invite, setInvite] = useState<Invitation | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ["inbox-team"] })
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work()
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y rounded-xl border" aria-label="Team">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2.5" data-role="member">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{m.name}</span>
              <span className="truncate text-xs text-muted-foreground">{m.role === "owner" ? "Owner (you)" : m.pending ? `${m.email} · hasn't joined yet` : m.email}</span>
            </div>
            {m.role === "member" && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void run(async () => setInvite(await reinviteTeamMember(m.id)))}>
                  New link
                </Button>
                <IconButton
                  icon="person_remove"
                  label={`Remove ${m.name}`}
                  variant="ghost-destructive"
                  size="icon-sm"
                  onClick={() => confirm(`Take ${m.name} off the team? They're signed out now, and what's assigned to them goes back to nobody.`) && void run(() => removeTeamMember(m.id))}
                />
              </>
            )}
          </li>
        ))}
      </ul>

      {invite ? (
        <InvitationLink invite={invite} onDone={() => setInvite(null)} />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              setInvite(await addTeamMember(name, email))
              setName("")
              setEmail("")
            })
          }}
        >
          <h3 className="text-sm font-medium">Add someone</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="member-name">Name</FieldLabel>
              <Input id="member-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="member-email">Email</FieldLabel>
              <Input id="member-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!name.trim() || !email.trim()}>
              Add and get a link
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

/** The one time the invitation's link shows: copy it and send it to them yourself. */
function InvitationLink({ invite, onDone }: { invite: Invitation; onDone: () => void }) {
  const url = invitationUrl(invite.code)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied", { duration: 2000 })
    } catch {
      toast.error("Couldn't reach the clipboard")
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3" data-role="invitation">
      <p className="text-sm">
        Send this link to <b>{invite.member.name}</b>. It works once, for {invite.days} days, and lets them choose a password. It won't show again.
      </p>
      <InputGroup>
        <InputGroupInput aria-label="Invitation link" readOnly value={url} onFocus={(e) => e.target.select()} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Copy link" onClick={() => void copy()}>
            <Icon name="content_copy" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
