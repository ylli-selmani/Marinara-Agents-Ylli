import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Focus, List, Maximize2, Minimize2, Network, RefreshCw, Search } from "lucide-react";
import { parseEntityRef } from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  buildLorebookGraph,
  classifyEntryWithFallback,
} from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmEntryNode,
  LmGraphEdge,
  LmGraphPayload,
  LmRetrievalInput,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  fetchLorebookManagerGraph,
  lmQueryKeys,
  patchEntryRelationships,
  patchLorebookEntry,
  type LmEntryPatch,
} from "./api";
import { FAMILY_META, LorebookGraph } from "./LorebookGraph";
import { SimulatePanel, type SimGraphHighlight } from "./SimulatePanel";
import type { CapabilityProps } from "./types";

const MANAGED_BOOKS_STORAGE_KEY = "lm:managed-books:v1";
const AUTO_SELECT_ENTRY_CEILING = 400;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function applyOptimisticEntryUpdate(
  payload: LmGraphPayload | undefined,
  entryId: string,
  patch: LmEntryPatch,
): LmGraphPayload | undefined {
  if (!payload) return payload;
  let changed = false;
  const nodes = payload.nodes.map((node) => {
    if (node.nodeType !== "lore" || node.id !== entryId) return node;
    changed = true;
    const nextTag = patch.tag !== undefined ? patch.tag.trim() : node.tag;
    const classification = classifyEntryWithFallback(nextTag, node.lorebookCategory);
    return {
      ...node,
      name: patch.name !== undefined ? patch.name : node.name,
      description: patch.description !== undefined ? patch.description : node.description,
      content: patch.content !== undefined ? patch.content : node.content,
      keys: patch.keys !== undefined ? patch.keys : node.keys,
      secondaryKeys: patch.secondaryKeys !== undefined ? patch.secondaryKeys : node.secondaryKeys,
      tag: nextTag,
      family: classification.family,
      secondaryFamilies: classification.secondaryFamilies,
      inferredFamily: classification.inferredFamily,
      enabled: patch.enabled !== undefined ? patch.enabled : node.enabled,
      constant: patch.constant !== undefined ? patch.constant : node.constant,
      characterFilterMode:
        patch.characterFilterMode !== undefined ? patch.characterFilterMode : node.characterFilterMode,
      characterFilterIds: patch.characterFilterIds !== undefined ? patch.characterFilterIds : node.characterFilterIds,
      relationships: patch.relationships !== undefined ? patch.relationships : node.relationships,
    };
  });
  return changed ? { ...payload, nodes } : payload;
}

function applyOptimisticRelationships(
  payload: LmGraphPayload | undefined,
  updates: Array<{ entry: LmEntryNode; relationships: Record<string, string> }>,
): LmGraphPayload | undefined {
  if (!payload || updates.length === 0) return payload;
  const relByRef = new Map(updates.map((item) => [item.entry.ref, item.relationships]));
  const nodes = payload.nodes.map((node) => {
    if (node.nodeType !== "lore") return node;
    const nextRels = relByRef.get(node.ref);
    return nextRels ? { ...node, relationships: nextRels } : node;
  });

  const nodeRefs = new Set(nodes.map((node) => node.ref));
  const explicitEdges: LmGraphEdge[] = payload.explicitEdges.filter((edge) => !relByRef.has(edge.sourceRef));
  for (const [sourceRef, rels] of relByRef) {
    for (const [rawTarget, relation] of Object.entries(rels)) {
      const parsed = parseEntityRef(rawTarget);
      if (!parsed || !nodeRefs.has(parsed.ref)) continue;
      explicitEdges.push({ kind: "explicit", sourceRef, targetRef: parsed.ref, relation });
    }
  }

  const explicitPairs = new Set(explicitEdges.map((edge) => pairKey(edge.sourceRef, edge.targetRef)));
  const mentionEdges = payload.mentionEdges.filter(
    (edge) => !explicitPairs.has(pairKey(edge.sourceRef, edge.targetRef)),
  );

  return { ...payload, nodes, explicitEdges, mentionEdges };
}

function readStoredManagedBooks(): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MANAGED_BOOKS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

function writeStoredManagedBooks(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MANAGED_BOOKS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage quota / private-browsing errors.
  }
}

export function LorebookManagerDetail({ props }: { props: CapabilityProps }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"graph" | "list" | "simulate">("graph");
  const [search, setSearch] = useState("");
  const [managedLorebookIds, setManagedLorebookIds] = useState<string[] | null>(() => readStoredManagedBooks());
  const [collapsedLorebookIds, setCollapsedLorebookIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [savingRef, setSavingRef] = useState<string | null>(null);
  const [simConfig, setSimConfig] = useState<LmRetrievalInput>({
    queryText: "",
    activeCharacterIds: [],
    activePersonaId: null,
    activeLocationText: "",
    tokenBudget: 2000,
    maxOneHop: 6,
    respectBookBudgets: true,
  });
  const [simHighlight, setSimHighlight] = useState<SimGraphHighlight | null>(null);

  const requestedIds = managedLorebookIds ?? [];
  const scopeKey = managedLorebookIds === null ? "__init__" : [...requestedIds].sort().join(",") || "__none__";

  const graphQuery = useQuery({
    queryKey: lmQueryKeys.graph(scopeKey),
    queryFn: () => fetchLorebookManagerGraph(requestedIds),
  });

  const payload = graphQuery.data;

  // On first visit (no saved selection yet), inspect library size from the metadata-only probe:
  // auto-load small libraries (<= 400 entries or single book), otherwise keep opt-in empty.
  useEffect(() => {
    if (managedLorebookIds !== null || !payload) return;
    const totalEntries = payload.lorebooks.reduce((sum, book) => sum + book.entryCount, 0);
    const initial =
      totalEntries <= AUTO_SELECT_ENTRY_CEILING || payload.lorebooks.length <= 1
        ? payload.lorebooks.map((book) => book.id)
        : [];
    writeStoredManagedBooks(initial);
    setManagedLorebookIds(initial);
  }, [managedLorebookIds, payload]);

  const managedSet = useMemo(() => new Set(managedLorebookIds ?? []), [managedLorebookIds]);

  const updateManagedBooks = (nextIds: string[]) => {
    const deduped = [...new Set(nextIds)];
    writeStoredManagedBooks(deduped);
    setManagedLorebookIds(deduped);
  };

  const toggleManagedBook = (lorebookId: string) => {
    const current = managedLorebookIds ?? [];
    if (managedSet.has(lorebookId)) {
      updateManagedBooks(current.filter((id) => id !== lorebookId));
      setCollapsedLorebookIds((prev) => {
        if (!prev.has(lorebookId)) return prev;
        const next = new Set(prev);
        next.delete(lorebookId);
        return next;
      });
    } else {
      updateManagedBooks([...current, lorebookId]);
    }
  };

  const toggleCollapseLorebook = (lorebookId: string) => {
    setCollapsedLorebookIds((current) => {
      const next = new Set(current);
      if (!next.delete(lorebookId)) next.add(lorebookId);
      return next;
    });
  };

  const listNodes = useMemo(() => {
    if (!payload) return [];
    return buildLorebookGraph(payload, {
      lorebookIds: managedSet,
      collapsedLorebookIds,
      search,
    }).nodes.sort((a, b) => a.name.localeCompare(b.name));
  }, [payload, managedSet, collapsedLorebookIds, search]);

  const incidentCounts = useMemo(() => {
    const map = new Map<string, { explicit: number; mention: number }>();
    if (!payload) return map;
    const bump = (ref: string, field: "explicit" | "mention") => {
      const entry = map.get(ref);
      if (entry) entry[field] += 1;
      else map.set(ref, field === "explicit" ? { explicit: 1, mention: 0 } : { explicit: 0, mention: 1 });
    };
    for (const edge of payload.explicitEdges) {
      bump(edge.sourceRef, "explicit");
      if (edge.targetRef !== edge.sourceRef) bump(edge.targetRef, "explicit");
    }
    for (const edge of payload.mentionEdges) {
      bump(edge.sourceRef, "mention");
      if (edge.targetRef !== edge.sourceRef) bump(edge.targetRef, "mention");
    }
    return map;
  }, [payload]);

  const handleBatchSaveRelationships = async (
    updates: Array<{ entry: LmEntryNode; relationships: Record<string, string> }>,
  ) => {
    if (updates.length === 0) return;
    setSavingRef(updates[0]!.entry.ref);
    try {
      const results = await Promise.allSettled(
        updates.map(({ entry, relationships }) => patchEntryRelationships(entry.lorebookId, entry.id, relationships)),
      );
      const succeededUpdates: typeof updates = [];
      const failureReasons: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          succeededUpdates.push(updates[index]!);
        } else {
          failureReasons.push(result.reason instanceof Error ? result.reason.message : "Could not save lorebook links");
        }
      });

      if (succeededUpdates.length > 0) {
        const hadRemoved = succeededUpdates.some(({ entry, relationships }) =>
          Object.keys(entry.relationships).some((key) => !(key in relationships)),
        );
        queryClient.setQueriesData<LmGraphPayload>({ queryKey: lmQueryKeys.root }, (current) =>
          applyOptimisticRelationships(current, succeededUpdates),
        );
        if (hadRemoved || failureReasons.length > 0) {
          void queryClient.invalidateQueries({ queryKey: lmQueryKeys.root });
        }
        void props.onLorebooksChanged?.();
      }

      if (failureReasons.length === 0) {
        toast.success(
          updates.length === 1 ? `Updated links for ${updates[0]!.entry.name}` : "Updated bidirectional link",
        );
      } else if (succeededUpdates.length > 0) {
        toast.error(
          `Saved ${succeededUpdates.length} of ${updates.length} link updates; refreshed to resync. ${failureReasons[0]}`,
        );
      } else {
        toast.error(failureReasons[0] ?? "Could not save lorebook links");
      }
    } finally {
      setSavingRef(null);
    }
  };

  const handleSaveRelationships = async (entry: LmEntryNode, nextRelationships: Record<string, string>) => {
    await handleBatchSaveRelationships([{ entry, relationships: nextRelationships }]);
  };

  const handleUpdateEntry = async (entry: LmEntryNode, patch: LmEntryPatch) => {
    const needsMentionRescan =
      patch.name !== undefined ||
      patch.keys !== undefined ||
      patch.content !== undefined ||
      patch.description !== undefined;
    setSavingRef(entry.ref);
    try {
      await patchLorebookEntry(entry.lorebookId, entry.id, patch);
      queryClient.setQueriesData<LmGraphPayload>({ queryKey: lmQueryKeys.root }, (current) =>
        applyOptimisticEntryUpdate(current, entry.id, patch),
      );
      if (needsMentionRescan) {
        void queryClient.invalidateQueries({ queryKey: lmQueryKeys.root });
      }
      void props.onLorebooksChanged?.();
      toast.success(`Saved ${patch.name ?? entry.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save lorebook entry");
      throw error;
    } finally {
      setSavingRef(null);
    }
  };

  const totalLibraryEntries = payload?.lorebooks.reduce((sum, book) => sum + book.entryCount, 0) ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-3">
      {!props.engineHeader ? (
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Lorebook Manager</h1>
            <p className="text-xs text-[var(--muted-foreground)]">
              Multi-lorebook knowledge graph over existing Engine entries, Character Cards, and Personas.
            </p>
          </div>
          {props.onClose ? (
            <button type="button" className="mari-chrome-control mari-chrome-control--small" onClick={props.onClose}>
              Back
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative min-w-[14rem] flex-1 max-w-md">
            <Search
              aria-hidden="true"
              size="0.875rem"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search entries, keys, cards, tags…"
              className="mari-chrome-field h-9 w-full rounded-lg pl-8 pr-3 text-sm md:text-xs"
            />
          </div>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            disabled={graphQuery.isFetching}
            onClick={() => void graphQuery.refetch()}
          >
            <RefreshCw aria-hidden="true" size="0.875rem" className={graphQuery.isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] p-0.5">
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            aria-pressed={view === "graph"}
            onClick={() => setView("graph")}
          >
            <Network aria-hidden="true" size="0.875rem" />
            Graph
          </button>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List aria-hidden="true" size="0.875rem" />
            List
          </button>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            aria-pressed={view === "simulate"}
            onClick={() => setView("simulate")}
          >
            <FlaskConical aria-hidden="true" size="0.875rem" />
            Simulate
          </button>
        </div>
      </div>

      {payload && payload.lorebooks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">Managed lorebooks:</span>
          {payload.lorebooks.length > 1 ? (
            <button
              type="button"
              className="mari-chrome-control mari-chrome-control--small"
              onClick={() => {
                if (managedSet.size === payload.lorebooks.length) {
                  updateManagedBooks([]);
                } else {
                  updateManagedBooks(payload.lorebooks.map((book) => book.id));
                }
              }}
            >
              {managedSet.size === payload.lorebooks.length
                ? `Unload all (${payload.lorebooks.length})`
                : `Load all (${payload.lorebooks.length})`}
            </button>
          ) : null}
          {payload.lorebooks.map((book) => {
            const active = managedSet.has(book.id);
            const collapsed = collapsedLorebookIds.has(book.id);
            return (
              <div key={book.id} className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small"
                  aria-pressed={active}
                  title={active ? `Click to unload ${book.name}` : `Click to opt ${book.name} into Lorebook Manager`}
                  onClick={() => toggleManagedBook(book.id)}
                >
                  <span>{book.name}</span>
                  <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{book.entryCount}</span>
                </button>
                {active ? (
                  <button
                    type="button"
                    className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
                    aria-pressed={collapsed}
                    aria-label={collapsed ? `Expand ${book.name} entries` : `Collapse ${book.name} into hub node`}
                    title={collapsed ? `Expand ${book.name} entries` : `Collapse ${book.name} into hub node`}
                    onClick={() => toggleCollapseLorebook(book.id)}
                  >
                    {collapsed ? <Maximize2 size="0.75rem" /> : <Minimize2 size="0.75rem" />}
                  </button>
                ) : null}
              </div>
            );
          })}
          {managedLorebookIds !== null && managedSet.size === 0 ? (
            <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
              · 0 loaded ({totalLibraryEntries} entries available — click a book)
            </span>
          ) : null}
        </div>
      ) : null}

      {graphQuery.isLoading ? (
        <div className="rounded-lg border border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
          Loading lorebook graph…
        </div>
      ) : graphQuery.error ? (
        <div role="alert" className="rounded-lg border border-[var(--destructive)]/40 p-4 text-sm">
          {graphQuery.error instanceof Error ? graphQuery.error.message : "Could not load lorebook graph"}
        </div>
      ) : payload ? (
        view === "graph" ? (
          <LorebookGraph
            payload={payload}
            selectedLorebookIds={managedSet}
            collapsedLorebookIds={collapsedLorebookIds}
            onToggleCollapseLorebook={toggleCollapseLorebook}
            onOpenLorebook={props.onOpenLorebook}
            onOpenCharacter={props.onOpenCharacter}
            onOpenPersona={props.onOpenPersona}
            search={search}
            selectedNodeRef={selectedNodeRef}
            onSelectNodeRef={setSelectedNodeRef}
            simHighlight={simHighlight}
            onClearSimHighlight={() => setSimHighlight(null)}
            onBackToSimulate={() => setView("simulate")}
            savingRef={savingRef}
            onSaveRelationships={handleSaveRelationships}
            onBatchSaveRelationships={handleBatchSaveRelationships}
            onUpdateEntry={handleUpdateEntry}
          />
        ) : view === "simulate" ? (
          <SimulatePanel
            payload={payload}
            managedLorebookIds={managedSet}
            config={simConfig}
            onChangeConfig={setSimConfig}
            onHighlightOnGraph={(highlight) => {
              setSimHighlight(highlight);
              setView("graph");
            }}
            onInspectNode={(ref) => {
              setSelectedNodeRef(ref);
              setView("graph");
            }}
          />
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {listNodes.length === 0 ? (
              <div className="p-6 text-sm text-[var(--muted-foreground)]">No matching entries.</div>
            ) : (
              listNodes.map((node) => {
                const counts = incidentCounts.get(node.ref);
                const explicitCount = counts?.explicit ?? 0;
                const mentionCount = counts?.mention ?? 0;
                return (
                  <div key={node.ref} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{node.name}</span>
                        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                          {node.nodeType === "lore"
                            ? `${node.lorebookName} · ${FAMILY_META[node.family].label}`
                            : node.nodeType === "lorebook"
                              ? `Lorebook (${node.entryCount})`
                              : node.nodeType}
                        </span>
                      </div>
                      {node.description ? (
                        <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">{node.description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                      <span>{explicitCount} links</span>
                      <span>{mentionCount} mentions</span>
                      <button
                        type="button"
                        className="mari-chrome-control mari-chrome-control--small"
                        onClick={() => {
                          setSelectedNodeRef(node.ref);
                          setView("graph");
                        }}
                      >
                        <Focus aria-hidden="true" size="0.75rem" />
                        Graph
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
