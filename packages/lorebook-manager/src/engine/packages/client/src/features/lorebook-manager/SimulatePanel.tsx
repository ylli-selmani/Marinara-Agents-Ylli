import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, Network, RotateCcw, Sparkles } from "lucide-react";
import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmEntityNode,
  LmGraphPayload,
  LmRetrievalActivatedItem,
  LmRetrievalInput,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";

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
  onHighlightOnGraph: (highlight: SimGraphHighlight) => void;
  onInspectNode: (ref: string) => void;
}

const TIER_LABEL: Record<LmRetrievalActivatedItem["tier"], string> = {
  constant: "Constant",
  direct: "Direct",
  graph_1hop: "1-hop",
};

const REASON_BADGE_STYLE: Record<string, { border: string; text: string }> = {
  constant: { border: "var(--border)", text: "var(--foreground)" },
  keyword: { border: "#22c55e", text: "#22c55e" },
  location: { border: "#14b8a6", text: "#14b8a6" },
  bm25: { border: "#3b82f6", text: "#60a5fa" },
  graph_1hop: { border: "#a855f7", text: "#c084fc" },
  card_inherited: { border: "#06b6d4", text: "#22d3ee" },
};

export function SimulatePanel({
  payload,
  managedLorebookIds,
  config,
  onChangeConfig,
  onHighlightOnGraph,
  onInspectNode,
}: SimulatePanelProps) {
  const [showSuppressed, setShowSuppressed] = useState(true);

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

  const result = useMemo(
    () => simulateLorebookRetrieval(payload, config, managedLorebookIds),
    [payload, config, managedLorebookIds],
  );

  const activeCardSet = useMemo(() => new Set(config.activeCharacterIds), [config.activeCharacterIds]);
  const nodeNamesByRef = useMemo(() => new Map(payload.nodes.map((node) => [node.ref, node.name])), [payload.nodes]);

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

  const resetInputs = () =>
    onChangeConfig({
      queryText: "",
      activeCharacterIds: [],
      activePersonaId: null,
      activeLocationText: "",
      tokenBudget: 2000,
      maxOneHop: 6,
      respectBookBudgets: true,
    });

  return (
    <div className="grid gap-4 lg:grid-cols-12 lg:items-start">
      {/* Left column: test scene & simulation parameters */}
      <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3.5 lg:col-span-5">
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

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--muted-foreground)]">Token budget</span>
              <span className="tabular-nums text-[var(--foreground)]">{config.tokenBudget}</span>
            </div>
            <input
              type="range"
              aria-label="Simulation token budget"
              min={500}
              max={8000}
              step={250}
              value={config.tokenBudget}
              onChange={(event) => onChangeConfig({ ...config, tokenBudget: Number(event.target.value) })}
              className="h-1.5 w-full accent-[var(--primary)]"
            />
          </label>

          <label className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--muted-foreground)]">Max 1-hop bonus</span>
              <span className="tabular-nums text-[var(--foreground)]">{config.maxOneHop}</span>
            </div>
            <input
              type="range"
              aria-label="Maximum 1-hop entries"
              min={0}
              max={15}
              step={1}
              value={config.maxOneHop}
              onChange={(event) => onChangeConfig({ ...config, maxOneHop: Number(event.target.value) })}
              className="h-1.5 w-full accent-[var(--primary)]"
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
      </div>

      {/* Right column: activation results & provenance */}
      <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3.5 lg:col-span-7">
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
              {result.cardInheritedSeedRefs.map((ref) => nodeNamesByRef.get(ref) ?? ref).join(", ")} while active
              card(s) are in context.
            </span>
          </div>
        ) : null}

        {loadedEntryCount === 0 ? (
          <div className="rounded border border-[var(--border)] p-4 text-xs text-[var(--muted-foreground)]">
            No lorebooks loaded yet. Opt a lorebook in above to test Stage 1 retrieval against its entries.
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
                        onClick={() => onInspectNode(item.entry.ref)}
                        className="truncate text-left font-medium hover:underline"
                      >
                        {item.entry.name}
                      </button>
                      <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                        {item.entry.lorebookName} · {TIER_LABEL[item.tier]}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[0.6875rem] text-[var(--muted-foreground)]">
                    <span className="tabular-nums">~{item.tokens} tok</span>
                    <button
                      type="button"
                      title="Open in Graph"
                      aria-label={`Inspect ${item.entry.name} in Graph`}
                      onClick={() => onInspectNode(item.entry.ref)}
                      className="p-0.5 hover:text-[var(--foreground)]"
                    >
                      <Eye size="0.8rem" />
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
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {result.suppressed.map((item) => (
                  <div
                    key={`sup-${item.entry.ref}`}
                    className="flex items-center justify-between gap-2 rounded border border-dashed border-[var(--border)] px-2.5 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => onInspectNode(item.entry.ref)}
                      className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    >
                      {item.entry.name}
                    </button>
                    <span className="shrink-0 text-[0.6875rem] text-[var(--muted-foreground)]">{item.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
