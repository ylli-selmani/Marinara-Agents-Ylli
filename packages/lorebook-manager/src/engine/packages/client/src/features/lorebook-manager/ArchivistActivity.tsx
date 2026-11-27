import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type {
  LmArchivistRunRecord,
  LmArchivistRunStatus,
  LmProposal,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { decideProposalApi, fetchArchivistRuns, fetchProposals, lmQueryKeys, runArchivistApi } from "./api";

// The Archivist's recent runs for one chat, above the retrieval runs. Precedent: the gate line and RunCard in
// ActivityPanel (same card border, same muted one-liners).

const STATUS_TEXT: Record<LmArchivistRunStatus, string> = {
  done: "Read the chat",
  failed: "Failed",
  unavailable: "No model connection",
  off: "Off for this chat",
  not_bound: "No Compendium on this chat",
  reply_pending: "Waiting for the reply to settle",
  cooling_down: "Paused after a failure",
  nothing_new: "Nothing new to read",
  not_due: "Not due yet",
};

function runLine(run: LmArchivistRunRecord, proposals: readonly LmProposal[]): string {
  if (run.status !== "done") return run.detail ? `${STATUS_TEXT[run.status]}: ${run.detail}` : STATUS_TEXT[run.status];
  const parts = [`${run.messageCount} ${run.messageCount === 1 ? "message" : "messages"}`];
  const made = run.updates + run.creates;
  const applied = run.proposalIds.filter((id) =>
    proposals.some((proposal) => proposal.id === id && proposal.appliedBy === "automatic"),
  ).length;
  parts.push(
    made === 0
      ? "nothing to suggest"
      : applied > 0
        ? `${applied} applied automatically${made > applied ? `, ${made - applied} to Review` : ""}`
        : `${run.updates} ${run.updates === 1 ? "update" : "updates"}, ${run.creates} new ${run.creates === 1 ? "entry" : "entries"} to Review`,
  );
  if (run.skipped.length > 0) parts.push(`${run.skipped.length} left out`);
  return parts.join(" · ");
}

function AutomaticChange({ proposal }: { proposal: LmProposal }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUndone = undone || proposal.status === "undone";
  const summary =
    proposal.kind === "create_entry"
      ? String(proposal.patch.content ?? "")
      : Array.isArray(proposal.patch.newFacts)
        ? proposal.patch.newFacts.join(" ")
        : proposal.reason;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await decideProposalApi(proposal.id, "undo");
      setUndone(true);
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not undo this change");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Applied automatically: {proposal.entryName}</span>
        <button
          type="button"
          disabled={busy || isUndone}
          onClick={() => void undo()}
          className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
        >
          {isUndone ? "Undone" : "Undo"}
        </button>
      </div>
      <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
        {summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}
      </p>
      {error ? (
        <p role="alert" className="text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Lights the chat's Agent activity icon while a run is in flight (Capability API 1.820; older Engines leave it out). */
function setBusy(chatId: string, busy: boolean) {
  const host = (
    globalThis as {
      __MARINARA_HOST__?: {
        stores?: {
          agent?: {
            getState?: () => { setPackageActivity?: (id: string, chat: string, s: { busy: boolean }) => void };
          };
        };
      };
    }
  ).__MARINARA_HOST__;
  host?.stores?.agent?.getState?.().setPackageActivity?.("lorebook-manager", chatId, { busy });
}

export function ArchivistActivity({ chatId, title = "Archivist" }: { chatId: string | null; title?: string }) {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: lmQueryKeys.archivistRuns,
    queryFn: fetchArchivistRuns,
    refetchInterval: 15_000,
  });
  const [running, setRunning] = useState(false);
  const proposalsQuery = useQuery({
    queryKey: lmQueryKeys.proposalsRoot,
    queryFn: () => fetchProposals(),
    refetchInterval: 15_000,
  });
  if (!chatId) return null;
  const proposals = proposalsQuery.data ?? [];
  const automatic = proposals
    .filter(
      (proposal) =>
        proposal.chatId === chatId &&
        proposal.source === "archivist" &&
        proposal.appliedBy === "automatic" &&
        (proposal.status === "applied" || proposal.status === "undone"),
    )
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
    .slice(0, 10);
  const runs = (runsQuery.data ?? []).filter((run) => run.chatId === chatId).slice(0, 3);

  const runNow = async () => {
    setRunning(true);
    setBusy(chatId, true);
    try {
      const outcome = await runArchivistApi(chatId);
      if (outcome.run?.status === "done") {
        const made = outcome.run.updates + outcome.run.creates;
        const latest = made > 0 ? await fetchProposals() : [];
        toast.success(
          made === 0
            ? "The Archivist found nothing new"
            : latest.some(
                  (proposal) => outcome.run!.proposalIds.includes(proposal.id) && proposal.appliedBy === "automatic",
                )
              ? runLine(outcome.run, latest)
              : `${made} suggestions are waiting in Review`,
        );
      } else {
        toast(
          outcome.run
            ? runLine(outcome.run, proposals)
            : (STATUS_TEXT[outcome.status as LmArchivistRunStatus] ?? "Done"),
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The Archivist could not run");
    } finally {
      setRunning(false);
      setBusy(chatId, false);
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.archivistRuns });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
    }
  };

  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--foreground)]">{title}</span>
        <button
          type="button"
          disabled={running}
          onClick={() => void runNow()}
          title="Reads this chat's settled messages now, whatever the mode and interval. One model call."
          className="mari-chrome-control mari-chrome-control--small inline-flex items-center gap-1 disabled:opacity-45"
        >
          {running ? <Loader2 size="0.75rem" className="animate-spin" /> : null}
          Run now
        </button>
      </div>
      {runs.length === 0 ? (
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
          No Archivist runs for this chat yet. It reads the chat after every few replies once its mode is on.
        </p>
      ) : (
        runs.map((run) => (
          <p
            key={run.at}
            className="text-[0.6875rem] text-[var(--muted-foreground)]"
            title={
              [run.model, `${run.ms} ms`, ...run.skipped.map((item) => `${item.name}: ${item.why}`)]
                .filter(Boolean)
                .join("\n") || undefined
            }
          >
            <span className="tabular-nums">{new Date(run.at).toLocaleTimeString()}</span>
            {run.trigger === "manual" ? " · Run now" : ""} · {runLine(run, proposals)}
          </p>
        ))
      )}
      {proposalsQuery.error ? (
        <p role="alert" className="text-[var(--destructive)]">
          Could not load automatic changes
        </p>
      ) : null}
      {automatic.map((proposal) => (
        <AutomaticChange key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
