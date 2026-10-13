import { useState } from "react"

import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { messages, type Message } from "@/data/mock"

const initials = (name: string) => name.split(" ").map((p) => p[0]).slice(0, 2).join("")

export function MailView() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lane, setLane] = useState("all")
  const selected = messages.find((m) => m.id === selectedId) ?? null
  const visible = lane === "unread" ? messages.filter((m) => m.unread) : messages

  return (
    <MasterDetail
      emptyIcon="mail"
      emptyLabel="Choose a conversation to read it here."
      onBack={() => setSelectedId(null)}
      header={
        <>
          <PaneHeader title="Inbox">
            <Button variant="ghost" size="icon" aria-label="Filter">
              <Icon name="filter_list" />
            </Button>
          </PaneHeader>
          <div className="flex flex-col gap-3 px-4 pb-3">
            <SearchField placeholder="Search mail" />
            {/* Unified inbox lanes — a seed for split-inbox / screener. */}
            <Tabs value={lane} onValueChange={(v) => setLane(String(v))}>
              <TabsList>
                <TabsTrigger value="all">All accounts</TabsTrigger>
                <TabsTrigger value="unread">Unread</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </>
      }
      list={visible.map((m) => (
        <ListRow
          key={m.id}
          selected={m.id === selectedId}
          onSelect={() => setSelectedId(m.id)}
          emphasized={m.unread}
          leading={
            <Avatar className="mt-0.5">
              <AvatarFallback>{initials(m.from)}</AvatarFallback>
            </Avatar>
          }
          title={m.from}
          meta={m.time}
          supporting={
            <>
              <span className="text-foreground">{m.subject}</span> — {m.preview}
            </>
          }
          trailing={m.starred ? <Icon name="star" fill className="mt-0.5 size-4 text-vertical-notes" label="Starred" /> : null}
        />
      ))}
      detail={selected && <MessageDetail message={selected} />}
    />
  )
}

function MessageDetail({ message }: { message: Message }) {
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-8 md:px-8 md:pt-6">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">{message.subject}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Archive">
            <Icon name="archive" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Snooze">
            <Icon name="snooze" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete">
            <Icon name="delete" />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Avatar size="lg">
          <AvatarFallback>{initials(message.from)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{message.from}</span>
          <span className="truncate text-xs text-muted-foreground">{message.email}</span>
        </div>
        <Badge variant="secondary" className="ml-auto">{message.account}</Badge>
      </div>
      <Separator />
      {/* Real mail bodies render in a sandboxed iframe after sanitizing. */}
      <div className="whitespace-pre-line text-[15px] leading-relaxed">{message.body}</div>
      <div className="flex gap-2 pt-2">
        <Button variant="outline">
          <Icon name="reply" data-icon="inline-start" /> Reply
        </Button>
        <Button variant="outline">
          <Icon name="forward" data-icon="inline-start" /> Forward
        </Button>
      </div>
    </article>
  )
}
