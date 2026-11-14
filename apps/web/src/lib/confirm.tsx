import { useCallback, useState, type ReactNode } from "react"

import { ConfirmDialog, type IconName } from "@unicron/ui"

/**
 * One question before a loss that cannot be undone (ADR-0087; brief X6;
 * cross-app decisions §10). What the code can undo is done at once, with
 * UNDO in a toast, and never asks.
 */
export interface Question {
  /** What it is about, as a mono caps line (`WORK // ACCOUNT`). */
  overline?: ReactNode
  /** The question: "Remove ana@example.com?" */
  title: ReactNode
  /** One line: what happens. Lines about what cannot be undone stay in full. */
  description?: ReactNode
  /** The yes, which repeats the verb that opened it: "Remove", "Delete", "Merge". Never "OK". */
  confirmLabel: string
  /** The no. "Cancel" unless the question has a better word ("Keep editing"). It takes focus. */
  cancelLabel?: string
  /** `destructive` (the default here): something is removed or lost. `default` for a yes that loses nothing. */
  tone?: "default" | "destructive"
  confirmIcon?: IconName
  /**
   * The yes's work. While it runs the question stays open with the yes
   * busy; if it fails, the question stays with the server's words in a
   * critical line.
   */
  run?: () => void | Promise<unknown>
}

/** What a question's body may add: the yes held back until a choice is made, with the reason shown. */
export interface QuestionBody {
  confirmDisabled?: boolean
  disabledReason?: ReactNode
}

/**
 * `useConfirm()` over unicron's `ConfirmDialog`: a question of 480 on a
 * desktop, a sheet on a phone; the yes repeats the verb; focus starts on the
 * no, so Enter never runs the yes by accident.
 *
 * ```tsx
 * const confirm = useConfirm()
 * const remove = async () => {
 *   if (await confirm.ask({ title: `Remove ${address}?`, description: "Mail on the server is not affected.", confirmLabel: "Remove", run: () => client.removeAccount(id) })) onGone()
 * }
 * return <>… {confirm.question()}</>
 * ```
 *
 * `question(children)` takes the body's extras, drawn live from the
 * caller's own state: `RadioRow`s for a scope, or
 * `ConfirmDialogConsequences`.
 */
export function useConfirm() {
  // The question asked last stays while it closes, so its words do not blank out as it fades.
  const [asked, setAsked] = useState<{ question: Question; answer: (yes: boolean) => void } | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ask = useCallback(
    (question: Question) =>
      new Promise<boolean>((answer) => {
        setError(null)
        setAsked({ question, answer })
        setOpen(true)
      }),
    [],
  )

  const question = (children?: ReactNode, body: QuestionBody = {}) => {
    if (!asked) return null
    const q = asked.question
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        overline={q.overline}
        title={q.title}
        description={q.description}
        confirmLabel={q.confirmLabel}
        cancelLabel={q.cancelLabel}
        tone={q.tone ?? "destructive"}
        confirmIcon={q.confirmIcon}
        confirmDisabled={body.confirmDisabled}
        disabledReason={body.disabledReason}
        error={error}
        onCancel={() => asked.answer(false)}
        onConfirm={async () => {
          setError(null)
          try {
            await q.run?.()
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            throw e
          }
          asked.answer(true)
        }}
      >
        {children}
      </ConfirmDialog>
    )
  }

  return { ask, question }
}
