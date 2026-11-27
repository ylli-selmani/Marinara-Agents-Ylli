import { normalizeFieldEdits } from "../../../../shared/src/features/agents/lorebook-manager/sheets.js";
import { LmSelect } from "./LmSelect";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Network, Redo2, RotateCcw, Sparkles, X } from "lucide-react";
import { LM_RELATIONS } from "../../../../shared/src/features/agents/lorebook-manager/relations.js";
import type {
  LmCompendium,
  LmCrawlerRunRecord,
  LmEntryNode,
  LmGraphPayload,
  LmProposal,
  LmProposalStatus,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  decideProposalApi,
  fetchCrawlerPending,
  fetchCrawlerRuns,
  fetchProposals,
  lmQueryKeys,
  redoCrawlerApi,
  runCrawlerApi,
} from "./api";
import { useFillHeight } from "./useFillHeight";

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
  undone: "Undone",
};

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  content: "Content",
  newFacts: "New facts",
  fieldEdits: "Field edits",
  addKeys: "New keywords",
  removeKeys: "Remove keywords",
  addLinks: "New links",
  description: "Summary",
  keys: "Keys",
  secondaryKeys: "Secondary keys",
  tag: "Tag",
  enabled: "Enabled",
  constant: "Always on",
  relationships: "Links",
  dynamicState: "Facets",
  wholeWords: "Turn on whole words",
  leftOut: "Left out",
};

/** Fields Review lets you trim or reword before Apply; the server takes only less, a relation or reworded text. */
const TEXT_FIELDS = new Set(["description", "tag"]);
const LIST_FIELDS = new Set(["addKeys", "removeKeys", "newFacts", "keys"]);
/** Every relation but `represents` (it hides an entry while its card is active): `related_to` is fine by hand. */
const EDIT_RELATIONS = LM_RELATIONS.filter((relation) => relation.value !== "represents");

interface ReviewLink {
  key: string;
  relation: string;
  name: string;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Your trims per suggestion version, kept while Lorebook Manager stays open: leaving Review and coming back (or a
 * refetch that redraws the list) shows the card as you left it.
 */
const draftCache = new Map<string, { draft: Record<string, unknown>; dropped: string[] }>();
const draftKey = (proposal: LmProposal) => `${proposal.id}:${proposal.revision}`;

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

const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

/** One removable item: a keyword, a fact or a link. Precedent: the entry editor's keyword chips. */
function Chip({ children, onRemove, label }: { children: React.ReactNode; onRemove?: () => void; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5">
      <span className="min-w-0 break-words">{children}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Leave out ${label}`}
          title="Leave out"
          onClick={onRemove}
          className="shrink-0 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <X size="0.7rem" />
        </button>
      ) : null}
    </span>
  );
}

/** A pending field you can trim or reword; applied and dismissed cards show their value only. */
function FieldValue({
  field,
  value,
  editable,
  onChange,
}: {
  field: string;
  value: unknown;
  editable: boolean;
  onChange: (next: unknown) => void;
}) {
  if (field === "fieldEdits") {
    const edits = normalizeFieldEdits(value);
    return (
      <div className="flex flex-wrap gap-1">
        {edits.map((edit) => (
          <Chip
            key={edit.field}
            label={edit.field}
            onRemove={editable ? () => onChange(edits.filter((other) => other.field !== edit.field)) : undefined}
          >
            {edit.field}:{" "}
            <span className={`text-[var(--muted-foreground)] ${edit.from === null ? "" : "line-through"}`}>
              {edit.from ?? "new line"}
            </span>{" "}
            → {edit.to}
          </Chip>
        ))}
      </div>
    );
  }
  if (editable && TEXT_FIELDS.has(field) && typeof value === "string") {
    return (
      <input
        aria-label={FIELD_LABEL[field] ?? field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mari-chrome-field h-7 w-full rounded px-2 text-xs"
      />
    );
  }
  if (editable && LIST_FIELDS.has(field) && Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    return (
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Chip key={item} label={item} onRemove={() => onChange(items.filter((other) => other !== item))}>
            {item}
          </Chip>
        ))}
      </div>
    );
  }
  if ((field === "wholeWords" || field === "leftOut") && Array.isArray(value)) {
    const items = value as Array<{ id: string; name: string }>;
    return (
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Chip
            key={item.id}
            label={item.name}
            onRemove={editable ? () => onChange(items.filter((other) => other.id !== item.id)) : undefined}
          >
            {item.name}
          </Chip>
        ))}
      </div>
    );
  }
  if (editable && field === "addLinks" && Array.isArray(value)) {
    const links = value as ReviewLink[];
    return (
      <div className="flex flex-wrap gap-1">
        {links.map((link) => (
          <Chip
            key={link.key}
            label={`${link.relation} → ${link.name}`}
            onRemove={() => onChange(links.filter((other) => other.key !== link.key))}
          >
            <LmSelect
              label={`Relation to ${link.name}`}
              value={link.relation}
              onChange={(nextValue) =>
                onChange(links.map((other) => (other.key === link.key ? { ...other, relation: nextValue } : other)))
              }
              className="mari-chrome-field h-6 rounded px-1 text-[0.6875rem]"
              options={EDIT_RELATIONS.map((relation) => ({
                value: relation.value,
                label: relation.value,
                description: relation.hint,
              }))}
            />{" "}
            → {link.name}
          </Chip>
        ))}
      </div>
    );
  }
  return <div>{formatValue(value, field)}</div>;
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
  onDecide: (decision: "apply" | "dismiss", patch?: Record<string, unknown>) => void;
  onInspectNode: (ref: string) => void;
}) {
  const isCreate = proposal.kind === "create_entry";
  const isBook = proposal.kind === "update_book";
  const pending = proposal.status === "pending";
  const duplicate = proposal.duplicateOfEntryId ? `lore:${proposal.duplicateOfEntryId}` : null;
  // The suggestion as you trimmed it; a field left out entirely is dropped from what Apply sends.
  const cached = draftCache.get(draftKey(proposal));
  const [draft, setDraft] = useState<Record<string, unknown>>(() => cached?.draft ?? { ...proposal.patch });
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set(cached?.dropped ?? []));
  const edited = pending && (dropped.size > 0 || !sameJson(draft, proposal.patch));
  useEffect(() => {
    if (edited) draftCache.set(draftKey(proposal), { draft, dropped: [...dropped] });
    else draftCache.delete(draftKey(proposal));
  }, [draft, dropped, edited, proposal]);
  const kept = Object.fromEntries(
    Object.entries(draft).filter(([field, value]) => !dropped.has(field) && !isBlank(value)),
  );
  const previousOf = (field: string): unknown => {
    if (proposal.before && field in proposal.before) return proposal.before[field];
    return current ? (current as unknown as Record<string, unknown>)[field] : undefined;
  };
  const shown = pending ? draft : proposal.patch;

  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{proposal.entryName || current?.name || "Untitled entry"}</span>
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {isCreate ? "New entry" : isBook ? "Lorebook" : "Update"} · {lorebookName}
          </span>
          <span className="text-[0.625rem] text-[var(--muted-foreground)]">
            {proposal.source === "crawler" ? "Crawler" : "Archivist"}
          </span>
          {edited ? <span className="text-[0.625rem] text-[var(--muted-foreground)]">· Edited</span> : null}
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
          {edited ? (
            <button
              type="button"
              title="Undo your edits to this suggestion"
              aria-label="Reset this suggestion"
              onClick={() => {
                setDraft({ ...proposal.patch });
                setDropped(new Set());
              }}
              className="p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <RotateCcw size="0.8rem" />
            </button>
          ) : null}
          {pending ? (
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
                disabled={busy || Object.keys(kept).length === 0}
                title={Object.keys(kept).length === 0 ? "Nothing left to apply; dismiss it instead" : undefined}
                className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
                onClick={() => onDecide("apply", edited ? kept : undefined)}
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
        {Object.entries(shown).map(([field, next]) => {
          const previous = isCreate ? undefined : previousOf(field);
          const leftOut = pending && (dropped.has(field) || (Array.isArray(next) && next.length === 0));
          const editable =
            pending &&
            (TEXT_FIELDS.has(field) ||
              LIST_FIELDS.has(field) ||
              field === "addLinks" ||
              field === "wholeWords" ||
              field === "fieldEdits");
          return (
            <div key={field} className="grid gap-0.5 border-t border-[var(--border)] pt-1 first:border-t-0 first:pt-0">
              <dt className="flex items-center justify-between gap-2 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
                <span>
                  {FIELD_LABEL[field] ?? field}
                  {leftOut ? " · left out" : ""}
                </span>
                {pending && !leftOut && !(isCreate && field === "content") ? (
                  <button
                    type="button"
                    title="Leave this out of the change"
                    aria-label={`Leave out ${FIELD_LABEL[field] ?? field}`}
                    onClick={() => setDropped((value) => new Set([...value, field]))}
                    className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    <X size="0.7rem" />
                  </button>
                ) : null}
              </dt>
              {leftOut ? null : (
                <dd className="space-y-0.5 whitespace-pre-wrap break-words">
                  {previous !== undefined && !isBlank(previous) && !Array.isArray(next) ? (
                    <div className="text-[var(--muted-foreground)] line-through">{formatValue(previous)}</div>
                  ) : null}
                  <FieldValue
                    field={field}
                    value={next}
                    editable={editable}
                    onChange={(value) => setDraft((draftValue) => ({ ...draftValue, [field]: value }))}
                  />
                </dd>
              )}
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
  const runsQuery = useQuery({ queryKey: lmQueryKeys.crawlerRuns, queryFn: fetchCrawlerRuns });
  const [running, setRunning] = useState<"tidy" | "redo" | null>(null);
  const remaining = pendingQuery.data;
  // Redo asks again about the newest finished batch (runs before round 6 didn't keep their entries).
  const lastBatch = (runsQuery.data ?? []).find(
    (record) => record.compendiumId === compendium.id && record.status === "done" && (record.entryIds?.length ?? 0) > 0,
  );
  const run = async (kind: "tidy" | "redo") => {
    setRunning(kind);
    try {
      const outcome: { status: string; run: LmCrawlerRunRecord | null; detail?: string | null } =
        kind === "redo" ? await redoCrawlerApi(compendium.id) : await runCrawlerApi(compendium.id);
      const record = outcome.run;
      if (record?.status === "done") {
        const entries = `${record.entryCount} ${record.entryCount === 1 ? "entry" : "entries"}`;
        const made = `${record.proposals} ${record.proposals === 1 ? "suggestion" : "suggestions"}`;
        toast.success(`Looked at ${entries}: ${made}`, record.detail ? { description: record.detail } : undefined);
      } else if (record?.status === "nothing_to_do" || outcome.status === "nothing_to_do") {
        toast(record?.detail ?? outcome.detail ?? "Every entry is tidied");
      } else {
        toast.error(record?.detail ?? "The Crawler could not run");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The Crawler could not run");
    } finally {
      setRunning(null);
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
        // Stays clickable with every entry tidied: it also makes the whole-words card for new entries.
        disabled={running !== null}
        onClick={() => void run("tidy")}
        title="Suggests a summary, a tag, keyword fixes and links for the next batch of entries. One model call."
        className="mari-chrome-control mari-chrome-control--small inline-flex items-center gap-1 disabled:opacity-45"
      >
        {running === "tidy" ? <Loader2 size="0.75rem" className="animate-spin" /> : <Sparkles size="0.75rem" />}
        Tidy entries
      </button>
      {lastBatch ? (
        <button
          type="button"
          disabled={running !== null}
          onClick={() => void run("redo")}
          title="When the model had a hiccup: dismisses the last batch's waiting suggestions and asks again about its entries. Applied ones stay. One model call."
          className="mari-chrome-control mari-chrome-control--small inline-flex items-center gap-1 disabled:opacity-45"
        >
          {running === "redo" ? <Loader2 size="0.75rem" className="animate-spin" /> : <Redo2 size="0.75rem" />}
          Redo last batch
        </button>
      ) : null}
      <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{remainingText}</span>
    </div>
  );
}

export function ReviewPanel({ payload, compendium, onInspectNode }: ReviewPanelProps) {
  const fillRef = useFillHeight<HTMLDivElement>();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LmProposalStatus>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Polls like Activity: a Crawler run after an Archivist Apply lands here without leaving and coming back (round 6).
  const proposalsQuery = useQuery({
    queryKey: lmQueryKeys.proposals(status),
    queryFn: () => fetchProposals(status),
    refetchInterval: 15_000,
  });

  const entriesById = useMemo(() => {
    const map = new Map<string, LmEntryNode>();
    for (const node of payload?.nodes ?? []) if (node.nodeType === "lore") map.set(node.id, node);
    return map;
  }, [payload]);
  const bookNames = useMemo(() => new Map((payload?.lorebooks ?? []).map((book) => [book.id, book.name])), [payload]);

  const decide = async (proposal: LmProposal, decision: "apply" | "dismiss", patch?: Record<string, unknown>) => {
    setBusyId(proposal.id);
    try {
      await decideProposalApi(proposal.id, decision, patch, patch ? proposal.revision : undefined);
      draftCache.delete(draftKey(proposal));
      toast.success(decision === "apply" ? "Change applied" : "Suggestion dismissed");
      await queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["lorebook-manager", "crawler-pending"] }),
        queryClient.invalidateQueries({ queryKey: ["lorebook-manager", "crawler-untidied"] }),
      ]);
      if (decision === "apply") await queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the suggestion");
      // A suggestion that changed meanwhile shows its new version (the card's draft starts over).
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
    } finally {
      setBusyId(null);
    }
  };

  const proposals = proposalsQuery.data ?? [];

  return (
    <div className="space-y-3 pr-1" ref={fillRef} style={{ overflowY: "auto" }}>
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
              : status === "undone"
                ? "No undone suggestions yet."
                : "No dismissed suggestions."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {proposals.map((proposal) => (
            <ProposalCard
              key={`${proposal.id}:${proposal.revision}`}
              proposal={proposal}
              current={proposal.targetEntryId ? (entriesById.get(proposal.targetEntryId) ?? null) : null}
              lorebookName={bookNames.get(proposal.lorebookId) ?? "Lorebook"}
              busy={busyId === proposal.id}
              onDecide={(decision, patch) => void decide(proposal, decision, patch)}
              onInspectNode={onInspectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
