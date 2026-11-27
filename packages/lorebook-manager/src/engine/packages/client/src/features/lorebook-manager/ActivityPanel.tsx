import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import type { LmLiveRunRecord } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchLiveRuns, lmQueryKeys } from "./api";
import { useFillHeight } from "./useFillHeight";
import { ArchivistActivity } from "./ArchivistActivity";
import { REASON_BADGE_STYLE, TIER_LABEL } from "./SimulatePanel";

export interface ActivityPanelProps {
  /** The chat the agent page was opened from, preselected when it has runs. */
  currentChatId: string | null;
  /** False on Engines without Capability API 1.839: live retrieval is off there. */
  liveRetrieval: boolean | undefined;
  onInspectNode: (ref: string) => void;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const SEMANTIC_STATUS_LABEL: Record<NonNullable<LmLiveRunRecord["semantic"]>["status"], string> = {
  off: "",
  used: "Meaning match",
  no_vectors: "Meaning match: no vectors yet, keywords only",
  timeout: "Meaning match: timed out, keywords only",
  error: "Meaning match failed, keywords only",
};

const GATE_MODE_LABEL: Record<NonNullable<LmLiveRunRecord["gate"]>["mode"], string> = {
  decision: "Decision model",
  librarian: "Librarian",
};

/** One line on what the Stage 2 gate did this turn. */
function gateLine(gate: NonNullable<LmLiveRunRecord["gate"]>): string {
  const mode = GATE_MODE_LABEL[gate.mode];
  const dropped = gate.dropped.length;
  switch (gate.status) {
    case "used":
    case "cached": {
      const kept = gate.checked - dropped;
      const how = gate.status === "cached" ? "same answer as before" : `${gate.ms} ms`;
      const orphaned = gate.orphaned ?? [];
      const names =
        (dropped > 0 ? ` (dropped ${gate.dropped.map((item) => item.name).join(", ")})` : "") +
        (orphaned.length > 0
          ? `; also left out, linked only through those: ${orphaned.map((item) => item.name).join(", ")}`
          : "");
      return `${mode} kept ${kept} of ${gate.checked} loose matches${names} · ${how}`;
    }
    case "nothing_to_check":
      return `${mode}: no loose matches to check`;
    case "unavailable":
      return `${mode} unavailable, kept all${gate.detail ? `: ${gate.detail}` : ""}`;
    case "timeout":
      return `${mode} timed out after ${gate.ms} ms, kept all`;
    case "skipped":
      return `${mode} skipped, no time left this turn`;
    default:
      return `${mode} failed, kept all`;
  }
}

function RunCard({ run, onInspectNode }: { run: LmLiveRunRecord; onInspectNode: (ref: string) => void }) {
  const semantic = run.semantic && run.semantic.status !== "off" ? run.semantic : null;
  return (
    <div className="space-y-1.5 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{formatWhen(run.at)}</span>
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {run.compendiumName}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]">
          <span>
            {run.activated.length} {run.activated.length === 1 ? "entry" : "entries"}
          </span>
          <span>
            ~{run.totalTokens}/{run.tokenBudget} tok
          </span>
          {/* Past the Engine's 5 s contributor limit the Engine scanned the books itself, so this run's lore wasn't used. */}
          <span
            className={run.totalMs !== undefined && run.totalMs > 5000 ? "text-amber-400" : undefined}
            title={
              run.totalMs === undefined
                ? undefined
                : run.totalMs > 5000
                  ? `Over the Engine's 5 s limit: the Engine used its own lorebook scan this turn (Stage 1 ${run.durationMs} ms)`
                  : `Stage 1 ${run.durationMs} ms, whole turn ${run.totalMs} ms`
            }
          >
            {run.totalMs ?? run.durationMs} ms
          </span>
        </div>
      </div>
      {run.reused ? (
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
          Same moment as the run before (a swipe, or the send after Peek): the same lore, nothing ran again.
        </p>
      ) : null}
      {semantic ? (
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]" title={semantic.detail ?? undefined}>
          {semantic.status === "no_vectors" && semantic.detail
            ? `Meaning match: ${semantic.detail}`
            : SEMANTIC_STATUS_LABEL[semantic.status]}
          {semantic.status === "used" || semantic.status === "timeout" ? ` · ${semantic.embedMs} ms` : ""}
          {semantic.vectorCount > 0 ? ` · ${semantic.vectorCount} vectors` : ""}
          {semantic.missingCount > 0 ? ` · ${semantic.missingCount} still vectorizing` : ""}
        </p>
      ) : null}
      {run.gate ? (
        <p
          className={`text-[0.6875rem] ${run.gate.status === "error" || run.gate.status === "timeout" ? "text-amber-400" : "text-[var(--muted-foreground)]"}`}
          title={[run.gate.model, run.gate.detail].filter(Boolean).join(" · ") || undefined}
        >
          {gateLine(run.gate)}
        </p>
      ) : null}
      {run.location ? (
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
          {run.location.source === "world_maps" ? "World Maps" : "World State"}: {run.location.text || "unnamed place"}
          {run.location.source === "world_maps"
            ? ` · ${run.location.linkedEntryCount} linked ${run.location.linkedEntryCount === 1 ? "entry" : "entries"}`
            : ""}
        </p>
      ) : null}
      {run.activated.length === 0 ? (
        <p className="text-[var(--muted-foreground)]">
          Nothing matched the last {run.queryMessageCount} {run.queryMessageCount === 1 ? "message" : "messages"}.
        </p>
      ) : (
        <div className="space-y-1">
          {run.activated.map((item) => (
            <div key={item.ref} className="space-y-1 border-t border-[var(--border)] pt-1 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium">{item.name}</span>
                  <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                    {item.lorebookName} · {TIER_LABEL[item.tier] ?? item.tier}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                  <span className="tabular-nums">~{item.tokens} tok</span>
                  <button
                    type="button"
                    title="Show in Graph"
                    aria-label={`Show ${item.name} in Graph`}
                    onClick={() => onInspectNode(item.ref)}
                    className="p-0.5 hover:text-[var(--foreground)]"
                  >
                    <Network size="0.8rem" />
                  </button>
                </div>
              </div>
              {item.injectedContent !== undefined ? (
                <p className="whitespace-pre-wrap">{item.injectedContent}</p>
              ) : null}
              {item.reasons.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {item.reasons.map((reason, index) => {
                    const palette = REASON_BADGE_STYLE[reason.kind] ?? {
                      border: "var(--border)",
                      text: "var(--muted-foreground)",
                    };
                    return (
                      <span
                        key={`${item.ref}-r-${index}`}
                        style={{ borderColor: palette.border, color: palette.text }}
                        className="rounded border px-1.5 py-0.5 text-[0.625rem]"
                      >
                        {reason.detail}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What live retrieval put into each chat's recent turns. Precedent: the Simulate results list in this package. */
export function ActivityPanel({ currentChatId, liveRetrieval, onInspectNode }: ActivityPanelProps) {
  const fillRef = useFillHeight<HTMLDivElement>();
  const runsQuery = useQuery({ queryKey: lmQueryKeys.runs, queryFn: fetchLiveRuns, refetchInterval: 15_000 });
  const chats = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  // A chat button clicked: the Archivist strip follows it instead of the open chat.
  const [pickedChat, setPickedChat] = useState(false);

  useEffect(() => {
    if (selectedChatId && chats.some((chat) => chat.chatId === selectedChatId)) return;
    const preferred = chats.find((chat) => chat.chatId === currentChatId) ?? chats[0];
    setSelectedChatId(preferred?.chatId ?? null);
  }, [chats, currentChatId, selectedChatId]);

  const selected = chats.find((chat) => chat.chatId === selectedChatId) ?? null;

  return (
    <div className="space-y-3 pr-1" ref={fillRef} style={{ overflowY: "auto" }}>
      {liveRetrieval === false ? (
        <div className="rounded border border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
          Live retrieval needs a newer Marinara Engine (Capability API 1.839). Until then the Engine injects your
          lorebooks itself, and Simulate shows what Lorebook Manager would pick.
        </div>
      ) : null}

      {/* The open chat even before it has retrieval runs; else the chat picked below. */}
      <ArchivistActivity
        showBackfill
        chatId={
          !pickedChat && currentChatId && !chats.some((chat) => chat.chatId === currentChatId)
            ? currentChatId
            : (selectedChatId ?? currentChatId)
        }
      />

      {chats.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {chats.map((chat) => (
            <button
              key={chat.chatId}
              type="button"
              className="mari-chrome-control mari-chrome-control--small"
              aria-pressed={chat.chatId === selectedChatId}
              onClick={() => {
                setSelectedChatId(chat.chatId);
                setPickedChat(true);
              }}
            >
              {chat.chatName}
            </button>
          ))}
        </div>
      ) : null}

      {runsQuery.error ? (
        <div role="alert" className="rounded-lg border border-[var(--destructive)]/40 p-4 text-sm">
          {runsQuery.error instanceof Error ? runsQuery.error.message : "Could not load activity"}
        </div>
      ) : runsQuery.isLoading ? null : !selected ? (
        <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
          No retrieval runs yet. Bind a Compendium to a chat and send a message: each turn&apos;s picks show up here,
          with why each entry was chosen.
        </div>
      ) : (
        <div className="space-y-1.5">
          {selected.runs.map((run) => (
            <RunCard key={run.at} run={run} onInspectNode={onInspectNode} />
          ))}
        </div>
      )}
    </div>
  );
}
