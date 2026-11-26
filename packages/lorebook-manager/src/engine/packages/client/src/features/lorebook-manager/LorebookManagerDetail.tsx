import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  BookMarked,
  Check,
  FlaskConical,
  Focus,
  FolderOpen,
  Inbox,
  List,
  Maximize2,
  Minimize2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  isImpliedMutualLink,
  parseEntityRef,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  buildLorebookGraph,
  classifyEntryWithFallback,
} from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmCompendium,
  LmEntityNode,
  LmEntryNode,
  LmGraphEdge,
  LmGraphPayload,
  LmRecallSettings,
  LmRetrievalInput,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { DEFAULT_RECALL_SETTINGS } from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import {
  createCompendiumApi,
  deleteCompendiumApi,
  fetchChatCompendiumBinding,
  fetchCompendiums,
  fetchLiveStatus,
  fetchLorebookManagerGraph,
  fetchProposals,
  fetchSettings,
  lmQueryKeys,
  patchEntryRelationships,
  patchLorebookEntry,
  setChatCompendiumBindingApi,
  updateCompendiumApi,
  type LmCompendiumSavePayload,
  type LmEntryPatch,
} from "./api";
import { ActivityPanel } from "./ActivityPanel";
import { CompendiumModal } from "./CompendiumModal";
import { confirmWithHostOrBrowser, getHostComponents } from "./host-components";
import { FAMILY_META, LorebookGraph } from "./LorebookGraph";
import { ReviewPanel } from "./ReviewPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SimulatePanel, type SimGraphHighlight } from "./SimulatePanel";
import type { CapabilityProps } from "./types";

const MANAGED_BOOKS_STORAGE_KEY = "lm:managed-books:v1";
const AUTO_SELECT_ENTRY_CEILING = 400;
const ADHOC_SCOPE_VALUE = "__adhoc__";
/** Retrieval settings outside any Compendium (whole-library view): the defaults from the Settings tab. */
function adHocRetrieval(
  recall: LmRecallSettings = DEFAULT_RECALL_SETTINGS,
): Pick<
  LmRetrievalInput,
  | "tokenBudget"
  | "maxOneHop"
  | "maxTextHits"
  | "respectBookBudgets"
  | "bookTokenBudgets"
  | "semanticThreshold"
  | "extraStopwords"
  | "bm25Strictness"
> {
  return {
    tokenBudget: recall.tokenBudget,
    maxOneHop: recall.maxOneHop,
    maxTextHits: recall.maxTextHits,
    respectBookBudgets: recall.respectBookBudgets,
    bookTokenBudgets: undefined,
    semanticThreshold: undefined,
    extraStopwords: recall.extraStopwords,
    bm25Strictness: recall.bm25Strictness,
  };
}

const LIBRARY_STYLE = `
[data-lm-compendium-grid] {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
}
@media (min-width: 48rem) {
  [data-lm-compendium-grid] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 72rem) {
  [data-lm-compendium-grid] {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
`;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function applyOptimisticEntryUpdate(
  payload: LmGraphPayload | undefined,
  entryId: string,
  patch: LmEntryPatch,
): LmGraphPayload | undefined {
  if (!payload || !Array.isArray(payload.nodes)) return payload;
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
  if (!payload || !Array.isArray(payload.nodes) || updates.length === 0) return payload;
  const relByRef = new Map(updates.map((item) => [item.entry.ref, item.relationships]));
  const nodes = payload.nodes.map((node) => {
    if (node.nodeType !== "lore") return node;
    const nextRels = relByRef.get(node.ref);
    return nextRels ? { ...node, relationships: nextRels } : node;
  });

  const nodeRefs = new Set(nodes.map((node) => node.ref));
  const explicitEdges: LmGraphEdge[] = payload.explicitEdges.filter((edge) => !relByRef.has(edge.sourceRef));
  for (const [sourceRef, rels] of relByRef) {
    // Every cached graph scope gets this merge; skip entries this scope doesn't show.
    if (!nodeRefs.has(sourceRef)) continue;
    for (const [rawTarget, relation] of Object.entries(rels)) {
      const parsed = parseEntityRef(rawTarget);
      if (!parsed || !nodeRefs.has(parsed.ref)) continue;
      explicitEdges.push({
        kind: "explicit",
        sourceRef,
        targetRef: parsed.ref,
        relation,
        ...(isImpliedMutualLink(parsed.ref, relation) ? { bidirectional: true } : {}),
      });
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
  const [surface, setSurface] = useState<"library" | "workbench">("library");
  const [view, setView] = useState<"graph" | "list" | "simulate" | "activity" | "review" | "settings">("graph");
  const [search, setSearch] = useState("");
  const [managedLorebookIds, setManagedLorebookIds] = useState<string[] | null>(() => readStoredManagedBooks());
  const [collapsedLorebookIds, setCollapsedLorebookIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [savingRef, setSavingRef] = useState<string | null>(null);
  const [selectedCompendiumId, setSelectedCompendiumId] = useState<string | null>(null);
  const [compendiumModal, setCompendiumModal] = useState<{ open: boolean; editing: LmCompendium | null }>({
    open: false,
    editing: null,
  });
  const [savingCompendium, setSavingCompendium] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const autoBoundChatRef = useRef<string | null>(null);
  // Compendium opened automatically from a chat binding; only this one closes again when the chat changes.
  const autoOpenedCompendiumIdRef = useRef<string | null>(null);

  const [simConfig, setSimConfig] = useState<LmRetrievalInput>({
    queryText: "",
    activeCharacterIds: [],
    activePersonaId: null,
    activeLocationText: "",
    ...adHocRetrieval(),
  });
  const [simHighlight, setSimHighlight] = useState<SimGraphHighlight | null>(null);

  const compendiumsQuery = useQuery({
    queryKey: lmQueryKeys.compendiums,
    queryFn: fetchCompendiums,
  });
  const liveStatusQuery = useQuery({ queryKey: lmQueryKeys.status, queryFn: fetchLiveStatus, staleTime: 60_000 });
  const settingsQuery = useQuery({ queryKey: lmQueryKeys.settings, queryFn: fetchSettings });
  const globalRecall = settingsQuery.data?.recall;
  // Read through a ref so applyCompendiumSettings keeps its identity (the auto-open effect depends on it).
  const globalRecallRef = useRef(globalRecall);
  globalRecallRef.current = globalRecall;
  const pendingProposalsQuery = useQuery({
    queryKey: lmQueryKeys.proposals("pending"),
    queryFn: () => fetchProposals("pending"),
  });
  const pendingCount = pendingProposalsQuery.data?.length ?? 0;

  const chatId = props.chatId ?? null;
  const chatBindingQuery = useQuery({
    queryKey: lmQueryKeys.chatBinding(chatId ?? "__none__"),
    queryFn: () => fetchChatCompendiumBinding(chatId!),
    enabled: Boolean(chatId),
  });

  const compendiums = useMemo(() => compendiumsQuery.data ?? [], [compendiumsQuery.data]);
  const activeCompendium = useMemo(
    () => (selectedCompendiumId ? (compendiums.find((c) => c.id === selectedCompendiumId) ?? null) : null),
    [compendiums, selectedCompendiumId],
  );

  const applyCompendiumSettings = useCallback((compendium: LmCompendium | null) => {
    if (!compendium) {
      // Leaving a Compendium: back to the whole-library defaults, keeping the scene inputs.
      setSimConfig((prev) => ({ ...prev, ...adHocRetrieval(globalRecallRef.current) }));
      return;
    }
    const charSet = new Set(compendium.characterIds);
    setSimConfig((prev) => ({
      ...prev,
      tokenBudget: compendium.retrievalSettings.tokenBudget,
      maxOneHop: compendium.retrievalSettings.maxOneHop,
      maxTextHits: compendium.retrievalSettings.maxTextHits,
      respectBookBudgets: compendium.retrievalSettings.respectBookBudgets,
      semanticThreshold: compendium.retrievalSettings.semanticThreshold,
      extraStopwords: compendium.retrievalSettings.extraStopwords,
      bm25Strictness: compendium.retrievalSettings.bm25Strictness,
      bookTokenBudgets:
        Object.keys(compendium.retrievalSettings.bookTokenBudgets).length > 0
          ? compendium.retrievalSettings.bookTokenBudgets
          : undefined,
      activeCharacterIds: prev.activeCharacterIds.filter((id) => charSet.has(id)),
    }));
  }, []);

  // The whole-library view follows the defaults: once they load, and after every save in the Settings tab.
  const hasActiveCompendium = activeCompendium !== null;
  useEffect(() => {
    if (globalRecall && !hasActiveCompendium) setSimConfig((prev) => ({ ...prev, ...adHocRetrieval(globalRecall) }));
  }, [globalRecall, hasActiveCompendium]);

  // When opened inside a chat bound to a Compendium, jump straight into that Compendium once.
  // The host keeps this component mounted across chat switches, so a Compendium that was auto-opened for the
  // previous chat closes when the new chat has no binding. One the user opened by hand stays open.
  useEffect(() => {
    const closeAutoOpened = () => {
      const autoId = autoOpenedCompendiumIdRef.current;
      autoOpenedCompendiumIdRef.current = null;
      if (autoId && selectedCompendiumId === autoId) {
        setSelectedCompendiumId(null);
        applyCompendiumSettings(null);
        setSurface("library");
      }
    };
    if (!chatId) {
      if (autoBoundChatRef.current !== null) closeAutoOpened();
      autoBoundChatRef.current = null;
      return;
    }
    if (autoBoundChatRef.current === chatId) return;
    const binding = chatBindingQuery.data;
    // Wait for a successful list: marking the chat handled after a failed fetch would skip the retry.
    if (!binding || !compendiumsQuery.isSuccess) return;
    autoBoundChatRef.current = chatId;
    const bound = binding.compendiumId ? compendiums.find((c) => c.id === binding.compendiumId) : undefined;
    if (bound) {
      autoOpenedCompendiumIdRef.current = bound.id;
      setSelectedCompendiumId(bound.id);
      applyCompendiumSettings(bound);
      setSurface("workbench");
    } else {
      closeAutoOpened();
    }
  }, [
    applyCompendiumSettings,
    chatBindingQuery.data,
    chatId,
    compendiums,
    compendiumsQuery.isSuccess,
    selectedCompendiumId,
  ]);

  // Drop stale selection if a Compendium was deleted externally.
  useEffect(() => {
    if (selectedCompendiumId && !compendiumsQuery.isLoading && !activeCompendium) {
      setSelectedCompendiumId(null);
      applyCompendiumSettings(null);
      setSurface("library");
    }
  }, [activeCompendium, applyCompendiumSettings, compendiumsQuery.isLoading, selectedCompendiumId]);

  const requestedLorebookIds =
    surface === "library" ? [] : activeCompendium ? activeCompendium.lorebookIds : (managedLorebookIds ?? []);
  const requestedCharacterIds = surface === "library" || !activeCompendium ? null : activeCompendium.characterIds;
  const requestedPersonaIds = surface === "library" || !activeCompendium ? null : activeCompendium.personaIds;

  const scopeKey =
    surface === "library"
      ? "__library_meta__"
      : activeCompendium
        ? `comp:${activeCompendium.id}:r${activeCompendium.revision}`
        : managedLorebookIds === null
          ? "__init__"
          : [...requestedLorebookIds].sort().join(",") || "__none__";

  const graphQuery = useQuery({
    queryKey: lmQueryKeys.graph(scopeKey),
    queryFn: () =>
      fetchLorebookManagerGraph({
        lorebookIds: requestedLorebookIds,
        characterIds: requestedCharacterIds,
        personaIds: requestedPersonaIds,
      }),
  });

  const payload = graphQuery.data;
  const lorebooksById = useMemo(
    () => new Map((payload?.lorebooks ?? []).map((book) => [book.id, book])),
    [payload?.lorebooks],
  );

  // On first workbench visit (no saved ad-hoc selection yet), inspect library size:
  // auto-load small libraries (<= 400 entries or single book), otherwise keep opt-in empty.
  useEffect(() => {
    if (surface !== "workbench" || activeCompendium || managedLorebookIds !== null || !payload) return;
    const totalEntries = payload.lorebooks.reduce((sum, book) => sum + book.entryCount, 0);
    const initial =
      totalEntries <= AUTO_SELECT_ENTRY_CEILING || payload.lorebooks.length <= 1
        ? payload.lorebooks.map((book) => book.id)
        : [];
    writeStoredManagedBooks(initial);
    setManagedLorebookIds(initial);
  }, [activeCompendium, managedLorebookIds, payload, surface]);

  const managedSet = useMemo(
    () => new Set(activeCompendium ? activeCompendium.lorebookIds : (managedLorebookIds ?? [])),
    [activeCompendium, managedLorebookIds],
  );
  const allBooksManaged = Boolean(
    payload && payload.lorebooks.length > 0 && payload.lorebooks.every((book) => managedSet.has(book.id)),
  );

  const visibleLorebooks = useMemo(() => {
    if (!payload) return [];
    if (!activeCompendium) return payload.lorebooks;
    const compSet = new Set(activeCompendium.lorebookIds);
    return payload.lorebooks.filter((book) => compSet.has(book.id));
  }, [activeCompendium, payload]);

  const updateManagedBooks = (nextIds: string[]) => {
    const deduped = [...new Set(nextIds)];
    writeStoredManagedBooks(deduped);
    setManagedLorebookIds(deduped);
  };

  const toggleManagedBook = (lorebookId: string) => {
    if (activeCompendium) return;
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

  const openCompendiumWorkbench = (compendium: LmCompendium | null) => {
    // Opened by hand: it stays open when the chat changes (only binding-opened ones close).
    autoOpenedCompendiumIdRef.current = null;
    setSelectedCompendiumId(compendium?.id ?? null);
    setCollapsedLorebookIds(new Set());
    setSelectedNodeRef(null);
    setSimHighlight(null);
    applyCompendiumSettings(compendium);
    setSurface("workbench");
  };

  const handleSelectCompendium = (nextValue: string) => {
    if (nextValue === ADHOC_SCOPE_VALUE) {
      openCompendiumWorkbench(null);
      return;
    }
    const target = compendiums.find((c) => c.id === nextValue) ?? null;
    openCompendiumWorkbench(target);
  };

  const handleSaveCompendium = async (data: LmCompendiumSavePayload, existingId?: string) => {
    setSavingCompendium(true);
    try {
      const saved = existingId ? await updateCompendiumApi(existingId, data) : await createCompendiumApi(data);
      await queryClient.invalidateQueries({ queryKey: lmQueryKeys.compendiums });
      setCompendiumModal({ open: false, editing: null });
      if (!existingId || selectedCompendiumId === saved.id) {
        openCompendiumWorkbench(saved);
      }
      toast.success(existingId ? `Saved Compendium "${saved.name}"` : `Created Compendium "${saved.name}"`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save Compendium");
    } finally {
      setSavingCompendium(false);
    }
  };

  const handleDeleteCompendium = async (target: LmCompendium) => {
    setSavingCompendium(true);
    try {
      try {
        await deleteCompendiumApi(target.id, target.revision);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not delete Compendium");
        return;
      }
      // The delete succeeded: always close and refresh, even if the binding refresh below fails.
      if (selectedCompendiumId === target.id) {
        setSelectedCompendiumId(null);
        applyCompendiumSettings(null);
        setSurface("library");
      }
      setCompendiumModal({ open: false, editing: null });
      toast.success(`Deleted Compendium "${target.name}"`);
      // The server clears every chat binding that pointed at it; refetch so badges drop it.
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: lmQueryKeys.compendiums }),
        queryClient.invalidateQueries({ queryKey: ["lorebook-manager", "chat-binding"] }),
      ]);
    } finally {
      setSavingCompendium(false);
    }
  };

  const handleDeleteFromLibraryCard = async (target: LmCompendium) => {
    const confirmed = await confirmWithHostOrBrowser({
      title: `Delete "${target.name}"?`,
      message: "Your lorebooks, Character Cards, and Personas stay untouched; only this Compendium bundle is removed.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!confirmed) return;
    await handleDeleteCompendium(target);
  };

  const handleBindCompendium = async (target: LmCompendium) => {
    if (!chatId) return;
    const isBoundHere = chatBindingQuery.data?.compendiumId === target.id;
    setBindingBusy(true);
    try {
      // Unbind only if this chat is still bound to it (another tab may have rebound it meanwhile).
      const updated = await setChatCompendiumBindingApi(
        chatId,
        isBoundHere ? null : target.id,
        isBoundHere ? target.id : null,
      );
      queryClient.setQueryData(lmQueryKeys.chatBinding(chatId), updated);
      toast.success(
        isBoundHere
          ? `Unbound "${target.name}" from ${props.chatName || "this chat"}`
          : `Bound "${target.name}" to ${props.chatName || "this chat"}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update chat binding");
    } finally {
      setBindingBusy(false);
    }
  };

  const handleBatchSaveRelationships = async (
    updates: Array<{ entry: LmEntryNode; relationships: Record<string, string> }>,
  ): Promise<boolean> => {
    if (updates.length === 0) return true;
    setSavingRef(updates[0]!.entry.ref);
    try {
      // A graph GET already in flight would land after the optimistic merge and revert it.
      const graphWasFetching = queryClient.isFetching({ queryKey: lmQueryKeys.graphRoot }) > 0;
      if (graphWasFetching) await queryClient.cancelQueries({ queryKey: lmQueryKeys.graphRoot });
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
        queryClient.setQueriesData<LmGraphPayload>({ queryKey: lmQueryKeys.graphRoot }, (current) =>
          applyOptimisticRelationships(current, succeededUpdates),
        );
        if (hadRemoved || failureReasons.length > 0 || graphWasFetching) {
          void queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
        }
        void notifyLorebooksChanged();
      } else if (graphWasFetching) {
        void queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
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
      return failureReasons.length === 0;
    } finally {
      setSavingRef(null);
    }
  };

  /** Host refresh after a save; its failure must not be reported as a failed save. */
  const notifyLorebooksChanged = async () => {
    try {
      await props.onLorebooksChanged?.();
    } catch {
      toast.error("Saved, but Marinara Engine couldn't refresh its lorebook list.");
    }
  };

  const handleSaveRelationships = async (entry: LmEntryNode, nextRelationships: Record<string, string>) => {
    return handleBatchSaveRelationships([{ entry, relationships: nextRelationships }]);
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
      queryClient.setQueriesData<LmGraphPayload>({ queryKey: lmQueryKeys.graphRoot }, (current) =>
        applyOptimisticEntryUpdate(current, entry.id, patch),
      );
      if (needsMentionRescan) {
        void queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot });
      }
      void notifyLorebooksChanged();
      toast.success(`Saved ${patch.name ?? entry.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save lorebook entry");
      throw error;
    } finally {
      setSavingRef(null);
    }
  };

  const totalLibraryEntries = payload?.lorebooks.reduce((sum, book) => sum + book.entryCount, 0) ?? 0;
  const hostComponents = getHostComponents();
  const HostSelect = hostComponents.Select;
  const compendiumOptions = useMemo(
    () => [
      {
        value: ADHOC_SCOPE_VALUE,
        label: "Ad-hoc Playground",
        description: "Pick lorebooks freely across your library",
      },
      ...compendiums.map((c) => ({
        value: c.id,
        label: c.name,
        description: `${c.lorebookIds.length} books · ${c.characterIds.length} cards · ${c.personaIds.length} personas`,
      })),
    ],
    [compendiums],
  );
  const boundHere = Boolean(chatId && activeCompendium && chatBindingQuery.data?.compendiumId === activeCompendium.id);

  const modalLoadedEntries = useMemo(
    () => (payload?.nodes ?? []).filter((node): node is LmEntryNode => node.nodeType === "lore"),
    [payload],
  );
  const modalCharacters = useMemo(
    () => (payload?.nodes ?? []).filter((node): node is LmEntityNode => node.nodeType === "character"),
    [payload],
  );
  const modalPersonas = useMemo(
    () => (payload?.nodes ?? []).filter((node): node is LmEntityNode => node.nodeType === "persona"),
    [payload],
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3">
      <style>{LIBRARY_STYLE}</style>

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

      {surface === "library" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/70 p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Compendiums</h2>
              <p className="text-xs text-[var(--muted-foreground)]">
                Bundle lorebooks, Character Cards, Personas, and token budgets per world or campaign. Your underlying
                lorebooks and cards stay untouched.
              </p>
              {chatId ? (
                <p className="text-xs text-[var(--foreground)]">
                  Current chat: <span className="font-medium">{props.chatName || chatId}</span>
                  {chatBindingQuery.data?.compendiumId
                    ? ` · Bound to "${compendiums.find((c) => c.id === chatBindingQuery.data?.compendiumId)?.name ?? chatBindingQuery.data.compendiumId}"`
                    : " · No Compendium bound yet"}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                onClick={() => openCompendiumWorkbench(null)}
              >
                <Network aria-hidden="true" size="0.875rem" />
                Ad-hoc Playground
              </button>
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small font-medium"
                onClick={() => setCompendiumModal({ open: true, editing: null })}
              >
                <Plus aria-hidden="true" size="0.875rem" />
                New Compendium
              </button>
            </div>
          </div>

          {compendiumsQuery.isLoading ? (
            <div className="rounded-xl border border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
              Loading Compendiums…
            </div>
          ) : compendiumsQuery.isError ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-[var(--border)] p-6">
              <p className="text-sm text-[var(--muted-foreground)]">
                Couldn't load your Compendiums.{" "}
                {compendiumsQuery.error instanceof Error ? compendiumsQuery.error.message : ""}
              </p>
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                onClick={() => void compendiumsQuery.refetch()}
              >
                Try again
              </button>
            </div>
          ) : compendiums.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)]/40 p-6">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">No Compendiums yet</h3>
                <p className="max-w-xl text-xs text-[var(--muted-foreground)]">
                  Create a Compendium to group specific lorebooks together with just the Character Cards, Personas, and
                  token budget that belong in that setting — or jump into the Ad-hoc Playground to inspect your full
                  library right away.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small font-medium"
                  onClick={() => setCompendiumModal({ open: true, editing: null })}
                >
                  <Plus aria-hidden="true" size="0.875rem" />
                  Create first Compendium
                </button>
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small"
                  onClick={() => openCompendiumWorkbench(null)}
                >
                  <FolderOpen aria-hidden="true" size="0.875rem" />
                  Open Ad-hoc Playground
                </button>
              </div>
            </div>
          ) : (
            <div data-lm-compendium-grid>
              {compendiums.map((comp) => {
                const isBoundToChat = Boolean(chatId && chatBindingQuery.data?.compendiumId === comp.id);
                const bookNames = comp.lorebookIds.map((id) => lorebooksById.get(id)?.name ?? id).slice(0, 3);
                const extraBooks = Math.max(0, comp.lorebookIds.length - bookNames.length);
                return (
                  <div
                    key={comp.id}
                    className="flex flex-col justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/75 p-4"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold">{comp.name}</h3>
                          {comp.description ? (
                            <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">
                              {comp.description}
                            </p>
                          ) : null}
                        </div>
                        {isBoundToChat ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--primary)]/50 bg-[var(--primary)]/10 px-1.5 py-0.5 text-[0.6875rem] font-medium">
                            <Check size="0.7rem" />
                            Chat active
                          </span>
                        ) : null}
                      </div>

                      <div className="text-[0.6875rem] text-[var(--muted-foreground)]">
                        {comp.lorebookIds.length} lorebook{comp.lorebookIds.length === 1 ? "" : "s"} ·{" "}
                        {comp.characterIds.length} card{comp.characterIds.length === 1 ? "" : "s"} ·{" "}
                        {comp.personaIds.length} persona{comp.personaIds.length === 1 ? "" : "s"} ·{" "}
                        {comp.retrievalSettings.tokenBudget} tok budget
                      </div>

                      {bookNames.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {bookNames.map((bookName, idx) => (
                            <span
                              key={`${comp.id}-b-${idx}`}
                              className="rounded border border-[var(--border)] bg-[var(--background)]/40 px-1.5 py-0.5 text-[0.6875rem] text-[var(--muted-foreground)]"
                            >
                              {bookName}
                            </span>
                          ))}
                          {extraBooks > 0 ? (
                            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                              +{extraBooks} more
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--border)] pt-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small font-medium"
                          onClick={() => openCompendiumWorkbench(comp)}
                        >
                          <FolderOpen aria-hidden="true" size="0.75rem" />
                          Open
                        </button>
                        {chatId ? (
                          <button
                            type="button"
                            disabled={bindingBusy}
                            aria-pressed={isBoundToChat}
                            className="mari-chrome-control mari-chrome-control--small"
                            onClick={() => void handleBindCompendium(comp)}
                          >
                            {isBoundToChat ? (
                              <Check aria-hidden="true" size="0.75rem" />
                            ) : (
                              <BookMarked aria-hidden="true" size="0.75rem" />
                            )}
                            {isBoundToChat ? "Bound" : "Use in chat"}
                          </button>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${comp.name}`}
                          className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
                          onClick={() => setCompendiumModal({ open: true, editing: comp })}
                        >
                          <Pencil aria-hidden="true" size="0.75rem" />
                        </button>
                        <button
                          type="button"
                          disabled={savingCompendium}
                          aria-label={`Delete ${comp.name}`}
                          className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon text-[var(--destructive)]"
                          onClick={() => void handleDeleteFromLibraryCard(comp)}
                        >
                          <Trash2 aria-hidden="true" size="0.75rem" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                onClick={() => setSurface("library")}
              >
                <ArrowLeft aria-hidden="true" size="0.75rem" />
                Compendiums
              </button>

              <div className="relative min-w-[11rem] flex-1 max-w-xs">
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

              <div className="flex items-center gap-1.5">
                {HostSelect ? (
                  <div className="min-w-[10.5rem]">
                    <HostSelect
                      value={activeCompendium?.id ?? ADHOC_SCOPE_VALUE}
                      options={compendiumOptions}
                      onChange={handleSelectCompendium}
                      label="Compendium scope"
                      placeholder="Ad-hoc Playground"
                      className="mari-chrome-field h-9 rounded-lg px-2.5 text-xs"
                    />
                  </div>
                ) : (
                  <label className="flex items-center gap-1.5 text-xs">
                    <BookMarked aria-hidden="true" size="0.875rem" className="text-[var(--muted-foreground)]" />
                    <select
                      aria-label="Compendium scope"
                      value={activeCompendium?.id ?? ADHOC_SCOPE_VALUE}
                      onChange={(event) => handleSelectCompendium(event.target.value)}
                      className="mari-chrome-field h-9 rounded-lg px-2 text-xs"
                    >
                      {compendiumOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small"
                  onClick={() => setCompendiumModal({ open: true, editing: null })}
                >
                  <Plus aria-hidden="true" size="0.875rem" />
                  New
                </button>
                {activeCompendium ? (
                  <button
                    type="button"
                    className="mari-chrome-control mari-chrome-control--small"
                    onClick={() => setCompendiumModal({ open: true, editing: activeCompendium })}
                  >
                    <Pencil aria-hidden="true" size="0.75rem" />
                    Edit
                  </button>
                ) : null}
                {chatId && activeCompendium ? (
                  <button
                    type="button"
                    disabled={bindingBusy}
                    aria-pressed={boundHere}
                    onClick={() => void handleBindCompendium(activeCompendium)}
                    title={
                      boundHere
                        ? `Unbind "${activeCompendium.name}" from ${props.chatName || "this chat"}`
                        : `Use "${activeCompendium.name}" by default in ${props.chatName || "this chat"}`
                    }
                    className="mari-chrome-control mari-chrome-control--small"
                  >
                    {boundHere ? (
                      <Check aria-hidden="true" size="0.75rem" />
                    ) : (
                      <BookMarked aria-hidden="true" size="0.75rem" />
                    )}
                    {boundHere ? `Bound: ${props.chatName || "chat"}` : `Bind to ${props.chatName || "chat"}`}
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                disabled={graphQuery.isFetching}
                onClick={() => {
                  void graphQuery.refetch();
                  void queryClient.invalidateQueries({ queryKey: lmQueryKeys.runs });
                  void queryClient.invalidateQueries({ queryKey: lmQueryKeys.proposalsRoot });
                }}
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
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                aria-pressed={view === "activity"}
                onClick={() => setView("activity")}
              >
                <ActivityIcon aria-hidden="true" size="0.875rem" />
                Activity
              </button>
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                aria-pressed={view === "review"}
                onClick={() => setView("review")}
              >
                <Inbox aria-hidden="true" size="0.875rem" />
                Review
                {pendingCount > 0 ? (
                  <span className="rounded-full bg-[var(--primary)] px-1.5 text-[0.625rem] tabular-nums text-[var(--primary-foreground)]">
                    {pendingCount}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                aria-pressed={view === "settings"}
                onClick={() => setView("settings")}
              >
                <SlidersHorizontal aria-hidden="true" size="0.875rem" />
                Settings
              </button>
            </div>
          </div>

          {payload &&
          (activeCompendium
            ? visibleLorebooks.length > 0 || activeCompendium.lorebookIds.length === 0
            : payload.lorebooks.length > 0) ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-[var(--muted-foreground)]">
                {activeCompendium ? "Compendium scope:" : "Managed lorebooks:"}
              </span>
              {!activeCompendium && payload.lorebooks.length > 1 ? (
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small"
                  onClick={() => {
                    if (allBooksManaged) {
                      updateManagedBooks([]);
                    } else {
                      updateManagedBooks(payload.lorebooks.map((book) => book.id));
                    }
                  }}
                >
                  {allBooksManaged
                    ? `Unload all (${payload.lorebooks.length})`
                    : `Load all (${payload.lorebooks.length})`}
                </button>
              ) : null}
              {visibleLorebooks.map((book) => {
                const active = managedSet.has(book.id);
                const collapsed = collapsedLorebookIds.has(book.id);
                const bookOverride = activeCompendium?.retrievalSettings.bookTokenBudgets[book.id];
                return (
                  <div key={book.id} className="inline-flex items-center gap-0.5">
                    {activeCompendium ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)]/60 px-2 py-0.5 text-xs">
                        <span>{book.name}</span>
                        <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                          {book.entryCount}
                          {bookOverride ? ` · ${bookOverride} tok` : ""}
                        </span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="mari-chrome-control mari-chrome-control--small"
                        aria-pressed={active}
                        title={
                          active ? `Click to unload ${book.name}` : `Click to opt ${book.name} into Lorebook Manager`
                        }
                        onClick={() => toggleManagedBook(book.id)}
                      >
                        <span>{book.name}</span>
                        <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{book.entryCount}</span>
                      </button>
                    )}
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
              {activeCompendium ? (
                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  · {activeCompendium.characterIds.length} cards · {activeCompendium.personaIds.length} personas ·{" "}
                  {activeCompendium.retrievalSettings.tokenBudget} tok budget
                </span>
              ) : managedLorebookIds !== null && managedSet.size === 0 ? (
                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  · 0 loaded ({totalLibraryEntries} entries available — click a book or create a Compendium)
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
            ) : view === "activity" ? (
              <ActivityPanel
                currentChatId={chatId}
                liveRetrieval={liveStatusQuery.data?.liveRetrieval}
                onInspectNode={(ref) => {
                  setSelectedNodeRef(ref);
                  setView("graph");
                }}
              />
            ) : view === "settings" ? (
              <SettingsPanel compendiums={compendiums} />
            ) : view === "review" ? (
              <ReviewPanel
                payload={payload}
                onInspectNode={(ref) => {
                  setSelectedNodeRef(ref);
                  setView("graph");
                }}
              />
            ) : view === "simulate" ? (
              <SimulatePanel
                payload={payload}
                managedLorebookIds={managedSet}
                config={simConfig}
                onChangeConfig={setSimConfig}
                savingRef={savingRef}
                onOpenLorebook={props.onOpenLorebook}
                onUpdateEntry={handleUpdateEntry}
                onHighlightOnGraph={(highlight) => {
                  setSimHighlight(highlight);
                  setView("graph");
                }}
                semanticEnabled={activeCompendium?.retrievalSettings.semanticEnabled ?? false}
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
        </>
      )}

      <CompendiumModal
        open={compendiumModal.open}
        compendium={compendiumModal.editing}
        lorebooks={payload?.lorebooks ?? []}
        loadedEntries={modalLoadedEntries}
        characters={modalCharacters}
        personas={modalPersonas}
        saving={savingCompendium}
        onClose={() => setCompendiumModal({ open: false, editing: null })}
        onSave={handleSaveCompendium}
        onDelete={handleDeleteCompendium}
      />
    </div>
  );
}
