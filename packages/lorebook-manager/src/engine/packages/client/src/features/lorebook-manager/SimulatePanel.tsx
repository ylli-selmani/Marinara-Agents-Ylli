import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Network, RotateCcw, Sparkles } from "lucide-react";
import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmEntityNode,
  LmEntryNode,
  LmGraphPayload,
  LmRetrievalActivatedItem,
  LmRetrievalInput,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchSemanticScores, lmQueryKeys, type LmEntryPatch } from "./api";
import { EntryReaderModal } from "./EntryReaderModal";

export type SimGraphHighlight = {
  directRefs: ReadonlySet<string>;
  oneHopRefs: ReadonlySet<string>;
  suppressedRefs: ReadonlySet<string>;
  seedRefs: ReadonlySet<string>;
  summary: string;
};

export interface SimulatePanelProps {
  payload: LmGraphPayload;
  managedLorebookIds: ReadonlySet<string>;
  config: LmRetrievalInput;
  onChangeConfig: (next: LmRetrievalInput) => void;
  savingRef: string | null;
  onOpenLorebook?: (lorebookId: string, entryId?: string) => void;
  onUpdateEntry: (entry: LmEntryNode, patch: LmEntryPatch) => Promise<void>;
  onHighlightOnGraph: (highlight: SimGraphHighlight) => void;
  onInspectNode: (ref: string) => void;
  /** The Compendium's meaning-match switch; Simulate then asks the server for the same similarities a turn uses. */
  semanticEnabled?: boolean;
}

const SIM_STYLE = `
[data-lm-sim-grid] {
  display: grid;
  gap: 0.875rem;
}
[data-lm-sim-results] {
  max-height: clamp(20rem, calc(100vh - 15rem), 46rem);
  overflow-y: auto;
}
@media (min-width: 64rem) {
  [data-lm-sim-grid] {
    grid-template-columns: minmax(19rem, 25rem) minmax(0, 1fr);
    align-items: start;
  }
}
`;

export const TIER_LABEL: Record<LmRetrievalActivatedItem["tier"], string> = {
  constant: "Constant",
  location: "Location",
  direct: "Direct",
  graph_1hop: "1-hop",
};

export const REASON_BADGE_STYLE: Record<string, { border: string; text: string }> = {
  constant: { border: "var(--border)", text: "var(--foreground)" },
  keyword: { border: "#22c55e", text: "#22c55e" },
  location: { border: "#14b8a6", text: "#14b8a6" },
  bm25: { border: "#3b82f6", text: "#60a5fa" },
  semantic: { border: "#f59e0b", text: "#fbbf24" },
  graph_1hop: { border: "#a855f7", text: "#c084fc" },
  card_inherited: { border: "#06b6d4", text: "#22d3ee" },
};

/** Number input that clamps on commit (blur/Enter) instead of every keystroke, so "1500" can be typed. */
function ClampedNumberInput({
  value,
  min,
  max,
  step,
  ariaLabel,
  className,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  className: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    setDraft(null);
    if (draft.trim() !== "" && Number.isFinite(next)) onCommit(Math.max(min, Math.min(max, next)));
  };
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className={className}
    />
  );
}

export function SimulatePanel({
  payload,
  managedLorebookIds,
  config,
  onChangeConfig,
  savingRef,
  onOpenLorebook,
  onUpdateEntry,
  onHighlightOnGraph,
  onInspectNode,
  semanticEnabled = false,
}: SimulatePanelProps) {
  const [showSuppressed, setShowSuppressed] = useState(true);
  const [readerState, setReaderState] = useState<{ ref: string; mode: "read" | "edit" } | null>(null);

  useEffect(() => {
    if (!readerState) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setReaderState(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readerState]);

  const characterCards = useMemo(
    () =>
      payload.nodes
        .filter((node): node is LmEntityNode => node.nodeType === "character")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [payload.nodes],
  );

  const loadedEntryCount = useMemo(
    () =>
      payload.nodes.filter(
        (node) =>
          node.nodeType === "lore" && (managedLorebookIds.size === 0 || managedLorebookIds.has(node.lorebookId)),
      ).length,
    [payload.nodes, managedLorebookIds],
  );

  // Wait for a pause in typing before embedding the scene text.
  const [settledQuery, setSettledQuery] = useState(config.queryText);
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(config.queryText), 500);
    return () => clearTimeout(timer);
  }, [config.queryText]);
  const semanticBookIds = useMemo(() => [...managedLorebookIds].sort(), [managedLorebookIds]);
  const semanticQuery = useQuery({
    queryKey: lmQueryKeys.semanticScores(semanticBookIds.join(","), settledQuery.trim()),
    queryFn: () => fetchSemanticScores(semanticBookIds, settledQuery),
    enabled: semanticEnabled && semanticBookIds.length > 0 && settledQuery.trim().length > 0,
    staleTime: 60_000,
  });
  const semanticInfo = semanticEnabled ? semanticQuery.data?.info : undefined;

  const result = useMemo(
    () =>
      simulateLorebookRetrieval(
        payload,
        semanticInfo?.status === "used" ? { ...config, semanticScores: semanticQuery.data!.scores } : config,
        managedLorebookIds,
      ),
    [payload, config, managedLorebookIds, semanticInfo, semanticQuery.data],
  );

  const activeCardSet = useMemo(() => new Set(config.activeCharacterIds), [config.activeCharacterIds]);
  const nodesByRef = useMemo(() => new Map(payload.nodes.map((node) => [node.ref, node])), [payload.nodes]);

  const toggleCharacter = (id: string) => {
    const next = activeCardSet.has(id)
      ? config.activeCharacterIds.filter((item) => item !== id)
      : [...config.activeCharacterIds, id];
    onChangeConfig({ ...config, activeCharacterIds: next });
  };

  const budgetPercent = Math.min(100, Math.round((result.totalTokens / Math.max(1, result.tokenBudget)) * 100));

  const buildHighlight = (): SimGraphHighlight => {
    const directRefs = new Set<string>();
    const oneHopRefs = new Set<string>();
    for (const item of result.activated) {
      if (item.tier === "graph_1hop") oneHopRefs.add(item.entry.ref);
      else directRefs.add(item.entry.ref);
    }
    const suppressedRefs = new Set(
      result.suppressed
        .filter((item) => item.reason === "excluded_by_card" || item.reason === "over_budget")
        .map((item) => item.entry.ref),
    );
    const seedRefs = new Set([...result.cardInheritedSeedRefs, ...config.activeCharacterIds.map((id) => `char:${id}`)]);
    return {
      directRefs,
      oneHopRefs,
      suppressedRefs,
      seedRefs,
      summary: `${directRefs.size} direct · ${oneHopRefs.size} 1-hop · ~${result.totalTokens}/${result.tokenBudget} tok`,
    };
  };

  // Only clears the scene fields; budgets and per-book caps (possibly from a Compendium) stay as configured.
  const resetInputs = () =>
    onChangeConfig({
      ...config,
      queryText: "",
      activeCharacterIds: [],
      activePersonaId: null,
      activeLocationText: "",
    });

  const readerNode = readerState ? (nodesByRef.get(readerState.ref) ?? null) : null;

  return (
    <div data-lm-sim-grid>
      <style>{SIM_STYLE}</style>

      {/* Left column: test scene & simulation parameters */}
      <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Simulate Retrieval (Stage 1 pure code)</h2>
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
              Instant local pass across {loadedEntryCount} loaded entries — 0 LLM calls.
            </p>
          </div>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            onClick={resetInputs}
            title="Clear simulation inputs"
          >
            <RotateCcw size="0.75rem" />
            Reset
          </button>
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-medium text-[var(--muted-foreground)]">Sample scene / recent chat messages</span>
          <textarea
            rows={5}
            value={config.queryText}
            onChange={(event) => onChangeConfig({ ...config, queryText: event.target.value })}
            placeholder="Paste 1–5 recent messages or scene cues (e.g. Deku steps onto the Sports Festival stage while All Might watches from the stands...)"
            className="mari-chrome-field w-full rounded-lg p-2.5 text-xs leading-relaxed"
          />
        </label>

        {characterCards.length > 0 ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--muted-foreground)]">Active Character Cards in chat</span>
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {config.activeCharacterIds.length} active
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {characterCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  aria-pressed={activeCardSet.has(card.id)}
                  onClick={() => toggleCharacter(card.id)}
                  className="mari-chrome-control mari-chrome-control--small text-xs"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block size-2 rounded-sm"
                    style={{ background: "var(--lm-graph-card, #06b6d4)" }}
                  />
                  {card.name}
                </button>
              ))}
            </div>
            <p className="text-[0.65rem] text-[var(--muted-foreground)]">
              Active cards suppress entries set to Exclude them and inherit 1-hop links from any <code>represents</code>{" "}
              entry.
            </p>
          </div>
        ) : null}

        <label className="block space-y-1 text-xs">
          <span className="font-medium text-[var(--muted-foreground)]">Simulated active location (optional)</span>
          <input
            type="text"
            value={config.activeLocationText ?? ""}
            onChange={(event) => onChangeConfig({ ...config, activeLocationText: event.target.value })}
            placeholder="e.g. U.A. High School"
            className="mari-chrome-field h-8 w-full rounded px-2.5 text-xs"
          />
        </label>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-2">
            <span className="font-medium text-[var(--muted-foreground)]">Token budget</span>
            <ClampedNumberInput
              ariaLabel="Simulation token budget"
              min={100}
              max={32000}
              step={1}
              value={config.tokenBudget}
              onCommit={(next) => onChangeConfig({ ...config, tokenBudget: next })}
              className="mari-chrome-field h-8 w-24 rounded px-2 text-xs tabular-nums"
            />
          </label>

          <label
            className="flex items-center gap-2"
            title="Maximum ID-linked neighbor entries pulled in via 1-hop bonus per turn"
          >
            <span className="font-medium text-[var(--muted-foreground)]">Max 1-hop bonus</span>
            <ClampedNumberInput
              ariaLabel="Maximum 1-hop bonus entries"
              min={0}
              max={25}
              step={1}
              value={config.maxOneHop}
              onCommit={(next) => onChangeConfig({ ...config, maxOneHop: next })}
              className="mari-chrome-field h-8 w-16 rounded px-2 text-xs tabular-nums"
            />
          </label>

          <label
            className="flex items-center gap-2"
            title="Cap on fuzzy BM25 text-only matches in Instant Mode (0 = keywords, locations & graph links only)"
          >
            <span className="font-medium text-[var(--muted-foreground)]">Max text hits</span>
            <ClampedNumberInput
              ariaLabel="Maximum fuzzy text hits"
              min={0}
              max={25}
              step={1}
              value={config.maxTextHits ?? 5}
              onCommit={(next) => onChangeConfig({ ...config, maxTextHits: next })}
              className="mari-chrome-field h-8 w-16 rounded px-2 text-xs tabular-nums"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <input
            type="checkbox"
            checked={config.respectBookBudgets !== false}
            onChange={(event) => onChangeConfig({ ...config, respectBookBudgets: event.target.checked })}
          />
          <span>Respect individual lorebook token budgets when set</span>
        </label>

        {config.bookTokenBudgets && Object.keys(config.bookTokenBudgets).length > 0 ? (
          <div className="rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
            Compendium per-book caps:{" "}
            {Object.entries(config.bookTokenBudgets)
              .map(([bookId, cap]) => {
                const name = payload.lorebooks.find((book) => book.id === bookId)?.name ?? bookId;
                return `${name} (${cap} tok)`;
              })
              .join(", ")}
          </div>
        ) : null}
      </div>

      {/* Right column: activation results & provenance */}
      <div data-lm-sim-results className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <span>Activated ({result.activated.length})</span>
              <span className="text-xs font-normal text-[var(--muted-foreground)]">
                ~{result.totalTokens} / {result.tokenBudget} tokens ({budgetPercent}%) · {result.durationMs.toFixed(1)}{" "}
                ms
              </span>
            </div>
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full bg-[var(--primary)] transition-all"
                style={{ width: `${budgetPercent}%` }}
              />
            </div>
          </div>

          <button
            type="button"
            disabled={result.activated.length === 0 && result.suppressed.length === 0}
            onClick={() => onHighlightOnGraph(buildHighlight())}
            className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
          >
            <Network size="0.875rem" />
            Highlight on Graph
          </button>
        </div>

        {result.cardInheritedSeedRefs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1.5 text-xs">
            <Sparkles size="0.8rem" className="shrink-0 text-cyan-400" />
            <span>
              Inherited 1-hop links from{" "}
              {result.cardInheritedSeedRefs.map((ref) => nodesByRef.get(ref)?.name ?? ref).join(", ")} while active
              card(s) are in context.
            </span>
          </div>
        ) : null}

        {loadedEntryCount === 0 ? (
          <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
            No lorebooks loaded yet. Opt a lorebook in above to test Stage 1 retrieval against its entries.
          </div>
        ) : result.activated.length === 0 && result.suppressed.length > 0 ? (
          <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
            Entries matched, but none were activated (token budgets or filters suppressed them). See the suppressed list
            below.
          </div>
        ) : result.activated.length === 0 ? (
          <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
            No entries matched yet. Enter keywords, story cues, or toggle an active Character Card or location to test
            activation and 1-hop graph expansion.
          </div>
        ) : (
          <div className="space-y-1.5">
            {result.activated.map((item) => (
              <div
                key={item.entry.ref}
                className="space-y-1 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2.5 py-2 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setReaderState({ ref: item.entry.ref, mode: "read" })}
                        className="truncate text-left font-medium hover:underline"
                      >
                        {item.entry.name}
                      </button>
                      <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                        {item.entry.lorebookName} · {TIER_LABEL[item.tier]}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                    <span className="tabular-nums">~{item.tokens} tok</span>
                    <button
                      type="button"
                      title="Read or edit inline"
                      aria-label={`Read ${item.entry.name}`}
                      onClick={() => setReaderState({ ref: item.entry.ref, mode: "read" })}
                      className="p-0.5 hover:text-[var(--foreground)]"
                    >
                      <FileText size="0.8rem" />
                    </button>
                    <button
                      type="button"
                      title="Show in Graph"
                      aria-label={`Show ${item.entry.name} in Graph`}
                      onClick={() => onInspectNode(item.entry.ref)}
                      className="p-0.5 hover:text-[var(--foreground)]"
                    >
                      <Network size="0.8rem" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {item.reasons.map((reason, idx) => {
                    const palette = REASON_BADGE_STYLE[reason.kind] ?? {
                      border: "var(--border)",
                      text: "var(--muted-foreground)",
                    };
                    return (
                      <span
                        key={`${item.entry.ref}-r-${idx}`}
                        style={{ borderColor: palette.border, color: palette.text }}
                        className="rounded border px-1.5 py-0.5 text-[0.625rem]"
                      >
                        {reason.detail}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {result.suppressed.length > 0 ? (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <button
              type="button"
              aria-expanded={showSuppressed}
              onClick={() => setShowSuppressed((v) => !v)}
              className="flex w-full items-center justify-between rounded px-1 py-0.5 text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <span className="flex items-center gap-1">
                {showSuppressed ? <ChevronDown size="0.8rem" /> : <ChevronRight size="0.8rem" />}
                <span>Suppressed / Skipped ({result.suppressed.length})</span>
              </span>
            </button>
            {showSuppressed ? (
              <div className="space-y-1">
                {result.suppressed.map((item) => (
                  <div
                    key={`sup-${item.entry.ref}`}
                    className="flex items-center justify-between gap-2 rounded border border-dashed border-[var(--border)] px-2.5 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setReaderState({ ref: item.entry.ref, mode: "read" })}
                      className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    >
                      {item.entry.name}
                    </button>
                    <span className="shrink-0 text-[0.6875rem] text-[var(--muted-foreground)]">{item.detail}</span>
                    <button
                      type="button"
                      title="Show in Graph"
                      aria-label={`Show ${item.entry.name} in Graph`}
                      onClick={() => onInspectNode(item.entry.ref)}
                      className="shrink-0 p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      <Network size="0.75rem" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <EntryReaderModal
        node={readerNode}
        initialMode={readerState?.mode ?? "read"}
        saving={Boolean(readerNode && savingRef === readerNode.ref)}
        onClose={() => setReaderState(null)}
        onOpenLorebook={onOpenLorebook}
        onUpdateEntry={onUpdateEntry}
      />
    </div>
  );
}
