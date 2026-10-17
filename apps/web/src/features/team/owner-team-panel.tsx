import { Skeleton } from "@unicron/ui"
import type { TeamThread } from "@/core/types"

import { TeamPanel } from "./team-panel"
import { useTeamDoc } from "./use-team-doc"

/** The team panel inside your own conversation, while it's shared (ADR-0060). */
export function OwnerTeamPanel({ share, onUseReply }: { share: TeamThread; onUseReply: (html: string) => void }) {
  const { doc, data } = useTeamDoc(share.id)
  // Sized by its wrapper: the library owns Skeleton's look.
  if (!doc || !data)
    return (
      <div className="h-40 w-full [&>*]:size-full [&>*]:rounded-2xl">
        <Skeleton />
      </div>
    )
  return <TeamPanel doc={doc} comments={data.comments} owner from={share.from} readOnly={false} onUseReply={onUseReply} />
}
