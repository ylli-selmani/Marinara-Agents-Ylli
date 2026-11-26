import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type {
  LmArchivistRunRecord,
  LmArchivistRunStatus,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchArchivistRuns, lmQueryKeys, runArchivistApi } from "./api";

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

function runLine(run: LmArchivistRunRecord): string {
  if (run.status !== "done") return run.detail ? `${STATUS_TEXT[run.status]}: ${run.detail}` : STATUS_TEXT[run.status];
  const parts = [`${run.messageCount} ${run.messageCount === 1 ? "message" : "messages"}`];
  const made = run.updates + run.creates;
  parts.push(
    made === 0
      ? "nothing to suggest"
      : `${run.updates} ${run.updates === 1 ? "update" : "updates"}, ${run.creates} new ${run.creates === 1 ? "entry" : "entries"} to Review`,
  );
  if (run.skipped.length > 0) parts.push(`${run.skipped.length} left out`);
  return parts.join(" · ");
}

export function ArchivistActivity({ chatId }: { chatId: string | null }) {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: lmQueryKeys.archivistRuns,
    queryFn: fetchArchivistRuns,
    refetchInterval: 15_000,
  });
  const [running, setRunning] = useState(false);
  if (!chatId) return null;
  const runs = (runsQuery.data ?? []).filter((run) => run.chatId === chatId).slice(0, 3);

  const runNow = async () => {
    setRunning(true);
    try {
      const outcome = await runArchivistApi(chatId);
      if (outcome.run?.status === "done") {
        const made = outcome.run.updates + outcome.run.creates;
        toast.success(made === 0 ? "The Archivist found nothing new" : `${made} suggestions are waiting in Review`);
      } else {
        toast(outcome.run ? runLine(outcome.run) : (STATUS_TEXT[outcome.status as LmArchivistRunStatus] ?? "Done"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The Archivist could not run");
    } finally {
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.archivistRuns });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
    }
  };

  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--foreground)]">Archivist</span>
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
            {run.trigger === "manual" ? " · Run now" : ""} · {runLine(run)}
          </p>
        ))
      )}
    </div>
  );
}
