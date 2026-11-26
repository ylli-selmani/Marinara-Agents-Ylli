import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Network, Sparkles, X } from "lucide-react";
import type {
  LmCompendium,
  LmEntryNode,
  LmGraphPayload,
  LmProposal,
  LmProposalStatus,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { decideProposalApi, fetchCrawlerPending, fetchProposals, lmQueryKeys, runCrawlerApi } from "./api";

export interface ReviewPanelProps {
  payload: LmGraphPayload | null;
  /** The Compendium open in the manager: Tidy entries runs over its books. */
  compendium: LmCompendium | null;
  onInspectNode: (ref: string) => void;
}

const STATUS_LABEL: Record<LmProposalStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  dismissed: "Dismissed",
};

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  content: "Content",
  newFacts: "New facts",
  addKeys: "New keywords",
  addLinks: "New links",
  description: "Summary",
  keys: "Keys",
  secondaryKeys: "Secondary keys",
  tag: "Tag",
  enabled: "Enabled",
  constant: "Always on",
  relationships: "Links",
  dynamicState: "Facets",
};

function formatValue(value: unknown, field?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "addLinks" && Array.isArray(value)) {
    return value
      .map((link) => {
        const item = (link ?? {}) as { relation?: unknown; name?: unknown };
        return `${String(item.relation ?? "?")} → ${String(item.name ?? "?")}`;
      })
      .join(", ");
  }
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(", ") : "—";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length > 0 ? entries.map(([key, inner]) => `${key}: ${formatValue(inner)}`).join(" · ") : "—";
  }
  return String(value);
}

function ProposalCard({
  proposal,
  current,
  lorebookName,
  busy,
  onDecide,
  onInspectNode,
}: {
  proposal: LmProposal;
  current: LmEntryNode | null;
  lorebookName: string;
  busy: boolean;
  onDecide: (decision: "apply" | "dismiss") => void;
  onInspectNode: (ref: string) => void;
}) {
  const isCreate = proposal.kind === "create_entry";
  const duplicate = proposal.duplicateOfEntryId ? `lore:${proposal.duplicateOfEntryId}` : null;
  const previousOf = (field: string): unknown => {
    if (proposal.before && field in proposal.before) return proposal.before[field];
    return current ? (current as unknown as Record<string, unknown>)[field] : undefined;
  };

  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{proposal.entryName || current?.name || "Untitled entry"}</span>
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {isCreate ? "New entry" : "Update"} · {lorebookName}
          </span>
          <span className="text-[0.625rem] text-[var(--muted-foreground)]">
            {proposal.source === "crawler" ? "Crawler" : "Archivist"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!isCreate && proposal.targetEntryId ? (
            <button
              type="button"
              title="Show in Graph"
              aria-label="Show this entry in Graph"
              onClick={() => onInspectNode(`lore:${proposal.targetEntryId}`)}
              className="p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <Network size="0.8rem" />
            </button>
          ) : null}
          {proposal.status === "pending" ? (
            <>
              <button
                type="button"
                disabled={busy}
                className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
                onClick={() => onDecide("dismiss")}
              >
                <X aria-hidden="true" size="0.8rem" />
                Dismiss
              </button>
              <button
                type="button"
                disabled={busy}
                className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
                onClick={() => onDecide("apply")}
              >
                <Check aria-hidden="true" size="0.8rem" />
                Apply
              </button>
            </>
          ) : null}
        </div>
      </div>

      {proposal.reason ? <p className="text-[var(--muted-foreground)]">{proposal.reason}</p> : null}

      {duplicate ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5">
          <AlertTriangle size="0.8rem" className="shrink-0 text-amber-400" />
          <span>Possible duplicate of an existing entry.</span>
          <button type="button" className="underline" onClick={() => onInspectNode(duplicate)}>
            Show it
          </button>
        </div>
      ) : null}

      <dl className="space-y-1">
        {Object.entries(proposal.patch).map(([field, next]) => {
          const previous = isCreate ? undefined : previousOf(field);
          return (
            <div key={field} className="grid gap-0.5 border-t border-[var(--border)] pt-1 first:border-t-0 first:pt-0">
              <dt className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">
                {FIELD_LABEL[field] ?? field}
              </dt>
              <dd className="space-y-0.5 whitespace-pre-wrap break-words">
                {previous !== undefined ? (
                  <div className="text-[var(--muted-foreground)] line-through">{formatValue(previous)}</div>
                ) : null}
                <div>{formatValue(next, field)}</div>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/**
 * Suggested lorebook changes from the Archivist and the Crawler (Tidy entries).
 * Precedent: Long-Term Memory's Review queue (approve / dismiss per item), drawn with this package's Simulate cards.
 */
/** Tidy entries: one Crawler batch over the open Compendium. Precedent: Activity's Archivist Run now. */
function TidyEntries({ compendium }: { compendium: LmCompendium }) {
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({
    queryKey: lmQueryKeys.crawlerPending(compendium.id),
    queryFn: () => fetchCrawlerPending(compendium.id),
  });
  const [running, setRunning] = useState(false);
  const remaining = pendingQuery.data;
  const run = async () => {
    setRunning(true);
    try {
      const outcome = await runCrawlerApi(compendium.id);
      const record = outcome.run;
      if (record?.status === "done") {
        const entries = `${record.entryCount} ${record.entryCount === 1 ? "entry" : "entries"}`;
        const made = `${record.proposals} ${record.proposals === 1 ? "suggestion" : "suggestions"}`;
        toast.success(`Looked at ${entries}: ${made}`);
      } else if (record?.status === "nothing_to_do") {
        toast("Every entry is tidied");
      } else {
        toast.error(record?.detail ?? "The Crawler could not run");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The Crawler could not run");
    } finally {
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.crawlerPending(compendium.id) });
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.crawlerRuns });
    }
  };
  const remainingText =
    remaining === undefined
      ? compendium.name
      : remaining === 0
        ? "Every entry in " + compendium.name + " is tidied"
        : remaining + (remaining === 1 ? " entry" : " entries") + " to tidy in " + compendium.name;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={running || remaining === 0}
        onClick={() => void run()}
        title="Suggests a summary, a tag, keywords and links for the next batch of entries. One model call."
        className="mari-chrome-control mari-chrome-control--small inline-flex items-center gap-1 disabled:opacity-45"
      >
        {running ? <Loader2 size="0.75rem" className="animate-spin" /> : <Sparkles size="0.75rem" />}
        Tidy entries
      </button>
      <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{remainingText}</span>
    </div>
  );
}

export function ReviewPanel({ payload, compendium, onInspectNode }: ReviewPanelProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LmProposalStatus>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const proposalsQuery = useQuery({ queryKey: lmQueryKeys.proposals(status), queryFn: () => fetchProposals(status) });

  const entriesById = useMemo(() => {
    const map = new Map<string, LmEntryNode>();
    for (const node of payload?.nodes ?? []) if (node.nodeType === "lore") map.set(node.id, node);
    return map;
  }, [payload]);
  const bookNames = useMemo(() => new Map((payload?.lorebooks ?? []).map((book) => [book.id, book.name])), [payload]);

  const decide = async (proposal: LmProposal, decision: "apply" | "dismiss") => {
    setBusyId(proposal.id);
    try {
      await decideProposalApi(proposal.id, decision);
      toast.success(decision === "apply" ? "Change applied" : "Suggestion dismissed");
      await queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
      if (decision === "apply") await queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the suggestion");
    } finally {
      setBusyId(null);
    }
  };

  const proposals = proposalsQuery.data ?? [];

  return (
    <div
      className="space-y-3 pr-1"
      style={{ maxHeight: "clamp(20rem, calc(100vh - 15rem), 46rem)", overflowY: "auto" }}
    >
      {compendium ? <TidyEntries compendium={compendium} /> : null}

      <div className="flex w-fit items-center gap-1 rounded-lg border border-[var(--border)] p-0.5">
        {(Object.keys(STATUS_LABEL) as LmProposalStatus[]).map((value) => (
          <button
            key={value}
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {STATUS_LABEL[value]}
          </button>
        ))}
      </div>

      {proposalsQuery.error ? (
        <div role="alert" className="rounded-lg border border-[var(--destructive)]/40 p-4 text-sm">
          {proposalsQuery.error instanceof Error ? proposalsQuery.error.message : "Could not load suggestions"}
        </div>
      ) : proposalsQuery.isLoading ? null : proposals.length === 0 ? (
        <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
          {status === "pending"
            ? "Nothing to review. The Archivist's suggestions from your chats and the Crawler's from Tidy entries wait here until you apply or dismiss them."
            : status === "applied"
              ? "No applied suggestions yet."
              : "No dismissed suggestions."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              current={proposal.targetEntryId ? (entriesById.get(proposal.targetEntryId) ?? null) : null}
              lorebookName={bookNames.get(proposal.lorebookId) ?? "Lorebook"}
              busy={busyId === proposal.id}
              onDecide={(decision) => void decide(proposal, decision)}
              onInspectNode={onInspectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
