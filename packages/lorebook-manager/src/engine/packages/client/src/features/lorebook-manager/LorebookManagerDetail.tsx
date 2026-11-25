import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Focus, List, Network, RefreshCw, Search } from "lucide-react";
import { buildLorebookGraph } from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import type { LmEntryNode } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchLorebookManagerGraph, lmQueryKeys, patchEntryRelationships } from "./api";
import { FAMILY_META, LorebookGraph } from "./LorebookGraph";
import type { CapabilityProps } from "./types";

export function LorebookManagerDetail({ props }: { props: CapabilityProps }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"graph" | "list">("graph");
  const [search, setSearch] = useState("");
  const [selectedLorebookIds, setSelectedLorebookIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [savingRef, setSavingRef] = useState<string | null>(null);

  const graphQuery = useQuery({
    queryKey: lmQueryKeys.graph,
    queryFn: fetchLorebookManagerGraph,
  });

  const payload = graphQuery.data;

  const listNodes = useMemo(() => {
    if (!payload) return [];
    return buildLorebookGraph(payload, {
      lorebookIds: selectedLorebookIds,
      search,
    }).nodes.sort((a, b) => a.name.localeCompare(b.name));
  }, [payload, selectedLorebookIds, search]);

  const toggleLorebook = (lorebookId: string) => {
    setSelectedLorebookIds((current) => {
      const next = new Set(current);
      if (!next.delete(lorebookId)) next.add(lorebookId);
      return next;
    });
  };

  const handleSaveRelationships = async (entry: LmEntryNode, nextRelationships: Record<string, string>) => {
    setSavingRef(entry.ref);
    try {
      await patchEntryRelationships(entry.lorebookId, entry.id, nextRelationships);
      await queryClient.invalidateQueries({ queryKey: lmQueryKeys.root });
      toast.success(`Updated links for ${entry.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save lorebook links");
    } finally {
      setSavingRef(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4">
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
        </div>
      </div>

      {payload && payload.lorebooks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">Lorebooks:</span>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            aria-pressed={selectedLorebookIds.size === 0}
            onClick={() => setSelectedLorebookIds(new Set())}
          >
            All ({payload.lorebooks.length})
          </button>
          {payload.lorebooks.map((book) => {
            const active = selectedLorebookIds.has(book.id);
            return (
              <button
                key={book.id}
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                aria-pressed={active}
                onClick={() => toggleLorebook(book.id)}
              >
                {book.name}
                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{book.entryCount}</span>
              </button>
            );
          })}
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
            selectedLorebookIds={selectedLorebookIds}
            search={search}
            selectedNodeRef={selectedNodeRef}
            onSelectNodeRef={setSelectedNodeRef}
            savingRef={savingRef}
            onSaveRelationships={handleSaveRelationships}
          />
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {listNodes.length === 0 ? (
              <div className="p-6 text-sm text-[var(--muted-foreground)]">No matching entries.</div>
            ) : (
              listNodes.map((node) => {
                const explicitCount = payload.explicitEdges.filter(
                  (edge) => edge.sourceRef === node.ref || edge.targetRef === node.ref,
                ).length;
                const mentionCount = payload.mentionEdges.filter(
                  (edge) => edge.sourceRef === node.ref || edge.targetRef === node.ref,
                ).length;
                return (
                  <div key={node.ref} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{node.name}</span>
                        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                          {node.nodeType === "lore"
                            ? `${node.lorebookName} · ${FAMILY_META[node.family].label}`
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
