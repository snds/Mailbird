import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { toast } from "sonner"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
} from "@unicron/ui"
import { getCoreClient, isMember, sayHere } from "@/core/client"
import { useInboxHere, useMe, useTeamMembers, useThreadTeam } from "@/core/queries"
import type { ThreadTeam } from "@/core/types"

import { initials } from "../mail/format"
import { peopleLine } from "../notes/presence"
import { CommentList } from "./team-panel"

const NOBODY: { id: string; name: string }[] = []

/** While a conversation is open, the gateway hears so, and tells the team (ADR-0063). */
function useHere(threadId: string) {
  useEffect(() => {
    const say = (t: string | null) => void sayHere(t).catch(() => {})
    say(threadId)
    // The gateway forgets after 70 seconds without hearing again.
    const beat = setInterval(() => say(threadId), 30_000)
    return () => {
      clearInterval(beat)
      say(null)
    }
  }, [threadId])
}

/** Who else has this conversation open. */
export function InboxHere({ threadId }: { threadId: string }) {
  const people = useInboxHere((s) => s[threadId] ?? NOBODY)
  const names = [...new Set(people.map((p) => p.name))]
  if (names.length === 0) return null
  return (
    <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" data-role="people-here">
      <AvatarGroup aria-hidden>
        {names.slice(0, 3).map((n) => (
          <Avatar key={n} size="sm">
            <AvatarFallback>{initials({ name: n, email: n })}</AvatarFallback>
          </Avatar>
        ))}
      </AvatarGroup>
      {peopleLine(names.map((name, id) => ({ id, name })))}
    </span>
  )
}

/**
 * A shared inbox's side of a conversation (ADR-0063): who it's assigned to,
 * notes the team leaves each other (never sent to anyone on it), and who
 * else has it open. Only on a gateway with a team.
 */
export function InboxTeamPanel({ threadId }: { threadId: string }) {
  useHere(threadId)
  const { data: team } = useThreadTeam(threadId)
  const { data: members = [] } = useTeamMembers()
  const me = useMe()
  const qc = useQueryClient()
  const joined = members.filter((m) => !m.pending)
  const put = (t: ThreadTeam) => qc.setQueryData(["inbox-team", "thread", threadId], t)
  const act = async (work: () => Promise<ThreadTeam | void>) => {
    try {
      const t = await work()
      if (t) put(t)
      else void qc.invalidateQueries({ queryKey: ["inbox-team", "thread", threadId] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const assignee = team?.assignee ?? null
  const assign = (id: string) => {
    const to = joined.find((m) => m.id === id) ?? null
    void act(async () => (await getCoreClient()).assignThread(threadId, to && { id: to.id, name: to.name }, me))
  }
  return (
    <section aria-label="Team" className="flex flex-col gap-4 rounded-2xl border px-4 py-4" data-role="inbox-team">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Icon name="group" /> Team
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <InboxHere threadId={threadId} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Icon name={assignee ? "assignment_ind" : "person_add"} data-icon="inline-start" />
              {assignee ? (assignee.id === me.id ? "Assigned to you" : `Assigned to ${assignee.name}`) : "Assign"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Who handles this</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={assignee?.id ?? ""} onValueChange={(v) => assign(String(v))}>
                  {joined.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} closeOnClick>
                      {m.id === me.id ? `${m.name} (you)` : m.name}
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value="" closeOnClick>
                    Nobody
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {assignee && (
        <p className="text-xs text-muted-foreground">
          {assignee.by === assignee.name ? `${assignee.name} took it.` : `${assignee.by} assigned it to ${assignee.id === me.id ? "you" : assignee.name}.`}
        </p>
      )}
      <CommentList
        label="Note"
        placeholder="Note for the team…"
        empty="Notes stay with the team: they never go to anyone on the conversation."
        // The owner can tidy anyone's; everyone else, their own.
        comments={(team?.comments ?? []).map((c) => ({ ...c, mine: c.authorId === me.id || !isMember() }))}
        onAdd={(text) => act(async () => (await getCoreClient()).addThreadComment(threadId, text, me))}
        onRemove={(id) => void act(async () => (await getCoreClient()).removeThreadComment(id, me, !isMember()))}
      />
    </section>
  )
}
