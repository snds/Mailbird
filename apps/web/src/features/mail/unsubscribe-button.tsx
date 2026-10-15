import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@unicron/ui"
import { useMailAction } from "@/core/queries"
import type { MessageDetail, Unsubscribe, UnsubscribeMethod } from "@/core/types"

import { displayName } from "./format"

/** What will happen, said before it happens: one request, a message, or a web page. */
function plan(u: Unsubscribe): string {
  if (u.oneClick) return "Mailbird asks the sender to remove you, in one request. Nothing opens and no message is sent."
  if (u.mailto) return `Mailbird sends an unsubscribe message to ${u.mailto.replace(/^mailto:/i, "").split("?")[0]} from this account.`
  return "The sender's unsubscribe page opens in your browser."
}

const DONE: Record<UnsubscribeMethod, string> = {
  one_click: "Unsubscribed",
  mail: "Unsubscribe request sent",
  web: "Opened the sender's unsubscribe page",
}

/** Shown on mail from a list that says how to leave it (List-Unsubscribe). */
export function UnsubscribeButton({ message, onArchive }: { message: MessageDetail; onArchive: () => void }) {
  const [open, setOpen] = useState(false)
  const unsubscribe = useMailAction<string>((c, id) => c.unsubscribe(id))
  const u = message.unsubscribe
  if (!u) return null
  const sender = displayName(message.from)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Icon name="unsubscribe" data-icon="inline-start" /> Unsubscribe
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unsubscribe from {sender}?</DialogTitle>
            <DialogDescription>{plan(u)}</DialogDescription>
          </DialogHeader>
          {unsubscribe.error && (
            <p role="alert" className="text-sm text-destructive">
              {unsubscribe.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={unsubscribe.isPending}
              onClick={() =>
                unsubscribe.mutate(message.id, {
                  onSuccess: (method) => {
                    setOpen(false)
                    toast.success(DONE[method as UnsubscribeMethod] ?? "Done", {
                      description: method === "web" ? undefined : `Mail already sent by ${sender} can take a few days to stop.`,
                      action: { label: "Archive", onClick: onArchive },
                    })
                  },
                })
              }
            >
              {unsubscribe.isPending ? "Unsubscribing…" : "Unsubscribe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
