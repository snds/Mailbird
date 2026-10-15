import { toast } from "sonner"

import { Icon, Button, Switch } from "@unicron/ui"
import { useMailAction, useScreener, useSenders } from "@/core/queries"
import type { Category, Sender } from "@/core/types"
import { CATEGORIES } from "@/features/mail/lanes"

const DECISION_LABEL = { screened_out: "Screened out", blocked: "Blocked", allowed: "Let in" } as const

/**
 * The Screener switch, and the senders you've screened out, blocked, or
 * moved, each with a way back (ADR-0018). Lives in Accounts.
 */
export function ScreenerSettingsSection() {
  const { data: status } = useScreener()
  const { data: senders = [] } = useSenders()
  const toggle = useMailAction<boolean>((c, on) => c.setScreener(on))
  const forget = useMailAction<{ email: string; what: "decision" | "category" }>((c, a) =>
    a.what === "decision" ? c.decideSender(a.email, null) : c.setSenderCategory(a.email, null),
  )
  if (!status) return null
  return (
    <section className="flex flex-col gap-3" aria-labelledby="screener-heading">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id="screener-heading" className="text-sm font-medium">
            Screen first-time senders
          </h3>
          <p className="text-xs text-muted-foreground">
            Mail from someone new waits in the Screener until you let them in. People you've written to and your contacts go straight to the inbox.
          </p>
        </div>
        <Switch
          checked={status.enabled}
          aria-labelledby="screener-heading"
          disabled={toggle.isPending}
          onCheckedChange={(on) =>
            toggle.mutate(on, { onSuccess: () => toast.success(on ? "The Screener is on. New senders will wait for your yes." : "The Screener is off. All mail goes to the inbox.") })
          }
        />
      </div>
      {senders.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border" aria-label="Senders you've decided about">
          {senders.map((s) => (
            <SenderRow key={s.email} sender={s} onForget={(what) => forget.mutate({ email: s.email, what })} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SenderRow({ sender: s, onForget }: { sender: Sender; onForget: (what: "decision" | "category") => void }) {
  const category = (c: Category) => CATEGORIES.find((x) => x.id === c)!.label
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Icon name={s.decision === "blocked" ? "block" : s.decision === "screened_out" ? "person_off" : "label"} className="size-5 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{s.name || s.email}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[s.name ? s.email : null, s.decision && DECISION_LABEL[s.decision], s.category && `Always in ${category(s.category)}`].filter(Boolean).join(" · ")}
        </span>
      </span>
      {s.decision && s.decision !== "allowed" && (
        <Button variant="ghost" size="sm" onClick={() => onForget("decision")}>
          {s.decision === "blocked" ? "Unblock" : "Let in again"}
        </Button>
      )}
      {s.category && (
        <Button variant="ghost" size="sm" onClick={() => onForget("category")}>
          Reset category
        </Button>
      )}
    </li>
  )
}
