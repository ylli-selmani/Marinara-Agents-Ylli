import { useQuery } from "@tanstack/react-query";
import { fetchProposals, lmQueryKeys } from "./api";
import { ArchivistActivity } from "./ArchivistActivity";
import type { CapabilityProps } from "./types";

/**
 * Lorebook Manager's card in a chat's Agent activity panel (the chat-activity slot, Capability API 1.820).
 * Precedent: Long-Term Memory's ActivityCard there. The body is Activity's Archivist strip, so both places read alike.
 */
export function ChatActivityCard({ props }: { props: CapabilityProps }) {
  const chatId = props.chatId ?? null;
  const pendingQuery = useQuery({
    queryKey: lmQueryKeys.proposals("pending"),
    queryFn: () => fetchProposals("pending"),
    enabled: Boolean(chatId),
    refetchInterval: 15_000,
  });
  if (!chatId) return null;
  const waiting = (pendingQuery.data ?? []).filter((proposal) => proposal.chatId === chatId).length;
  const open = props.onOpenAgentSettings;
  return (
    <div className="space-y-1">
      <ArchivistActivity chatId={chatId} title="Lorebook Manager · Archivist" />
      {waiting > 0 || open ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
          <span>
            {waiting > 0 ? `${waiting} ${waiting === 1 ? "suggestion waits" : "suggestions wait"} in Review` : null}
          </span>
          {open ? (
            <button type="button" onClick={open} className="underline hover:text-[var(--foreground)]">
              Open Lorebook Manager
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
