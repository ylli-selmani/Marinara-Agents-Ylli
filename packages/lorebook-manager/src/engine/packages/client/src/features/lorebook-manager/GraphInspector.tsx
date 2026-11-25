import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Focus,
  Link2,
  Maximize2,
  Minimize2,
  Move,
  PanelRight,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  parseEntityRef,
  toRelationshipKey,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import type {
  LmEntryNode,
  LmGraphEdge,
  LmGraphNode,
  LmGraphPayload,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import type { LmEntryPatch } from "./api";

export const RELATION_PRESETS = [
  "related_to",
  "located_in",
  "member_of",
  "ally_of",
  "rival_of",
  "owns",
  "part_of",
] as const;

export const SYMMETRIC_RELATIONS = new Set<string>(["related_to", "ally_of", "rival_of"]);

const TAG_OVERRIDES = ["", "lore", "character", "location", "faction", "item", "creature", "ability", "quest"] as const;
const SECTION_AUTO_COLLAPSE = 6;

type PromoteDirection = "outgoing" | "incoming" | "both";

function nodeSnippet(node: LmGraphNode | undefined): string {
  if (!node) return "";
  const raw = (node.description || (node.nodeType === "lore" ? node.content : "")).replace(/\s+/g, " ").trim();
  return raw.length > 220 ? `${raw.slice(0, 219)}…` : raw;
}

function parseTagList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function CollapsibleSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="space-y-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded px-1 py-0.5 text-[0.6875rem] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)]/30 hover:text-[var(--foreground)]"
      >
        <span className="flex items-center gap-1">
          {open ? <ChevronDown size="0.75rem" /> : <ChevronRight size="0.75rem" />}
          <span>{title}</span>
        </span>
        <span>{count}</span>
      </button>
      {open ? <div className="flex flex-col gap-1">{children}</div> : null}
    </div>
  );
}

type EditingLinkState = {
  id: string;
  sourceEntry: LmEntryNode | null;
  targetEntry: LmEntryNode | null;
  sourceRef: string;
  targetRef: string;
  relation: string;
  bothWays: boolean;
  wasBothWays: boolean;
};

export interface GraphInspectorProps {
  activeNode: LmGraphNode;
  nodeColour: string;
  familyLabel: string;
  payload: LmGraphPayload;
  allNodesByRef: ReadonlyMap<string, LmGraphNode>;
  canvasWrap: HTMLDivElement | null;
  floating: boolean;
  onToggleFloating: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onFocusHere: (ref: string) => void;
  onNavigate: (ref: string | null) => void;
  onOpenReader: (node: LmGraphNode, mode: "read" | "edit") => void;
  onOpenLorebook?: (lorebookId: string) => void;
  onToggleCollapseLorebook: (lorebookId: string) => void;
  savingRef: string | null;
  onSaveRelationships: (entry: LmEntryNode, nextRelationships: Record<string, string>) => Promise<void>;
  onBatchSaveRelationships: (
    updates: Array<{ entry: LmEntryNode; relationships: Record<string, string> }>,
  ) => Promise<void>;
  onUpdateEntry: (entry: LmEntryNode, patch: LmEntryPatch) => Promise<void>;
}

export function GraphInspector({
  activeNode,
  nodeColour,
  familyLabel,
  payload,
  allNodesByRef,
  canvasWrap,
  floating,
  onToggleFloating,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onFocusHere,
  onNavigate,
  onOpenReader,
  onOpenLorebook,
  onToggleCollapseLorebook,
  savingRef,
  onSaveRelationships,
  onBatchSaveRelationships,
  onUpdateEntry,
}: GraphInspectorProps) {
  const cardRef = useRef<HTMLElement>(null);
  const dragCard = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [relationDraft, setRelationDraft] = useState<string>("related_to");
  const [promoteDirection, setPromoteDirection] = useState<PromoteDirection>("both");
  const [addTargetRef, setAddTargetRef] = useState<string>("");
  const [addRelation, setAddRelation] = useState<string>("related_to");
  const [addBothWays, setAddBothWays] = useState<boolean>(true);
  const [addFlipped, setAddFlipped] = useState<boolean>(false);
  const [editingLink, setEditingLink] = useState<EditingLinkState | null>(null);
  const [sectionOpenOverrides, setSectionOpenOverrides] = useState<Record<string, boolean>>({});

  const explicitGroups = useMemo(() => {
    const outItems: Array<{ key: string; targetRef: string; targetName: string; relation: string }> = [];
    if (activeNode.nodeType === "lore") {
      for (const [key, relation] of Object.entries(activeNode.relationships)) {
        const parsed = parseEntityRef(key);
        if (!parsed) continue;
        outItems.push({
          key,
          targetRef: parsed.ref,
          targetName: allNodesByRef.get(parsed.ref)?.name ?? key,
          relation,
        });
      }
    }

    const inBySource = new Map<string, LmGraphEdge>();
    for (const edge of payload.explicitEdges) {
      if (edge.targetRef === activeNode.ref) inBySource.set(edge.sourceRef, edge);
    }

    const mutual: Array<{
      otherRef: string;
      otherName: string;
      outKey: string;
      outRel: string;
      inRel: string;
      otherEntry: LmEntryNode | null;
    }> = [];
    const outgoing: typeof outItems = [];
    const matchedIncoming = new Set<string>();

    for (const item of outItems) {
      const rev = inBySource.get(item.targetRef);
      if (rev) {
        matchedIncoming.add(item.targetRef);
        const other = allNodesByRef.get(item.targetRef);
        mutual.push({
          otherRef: item.targetRef,
          otherName: item.targetName,
          outKey: item.key,
          outRel: item.relation,
          inRel: rev.relation,
          otherEntry: other?.nodeType === "lore" ? other : null,
        });
      } else {
        outgoing.push(item);
      }
    }

    const incoming: Array<{
      sourceRef: string;
      sourceName: string;
      relation: string;
      sourceEntry: LmEntryNode | null;
      keyOnSource: string;
    }> = [];
    for (const [sourceRef, edge] of inBySource) {
      if (matchedIncoming.has(sourceRef)) continue;
      const sourceNode = allNodesByRef.get(sourceRef);
      incoming.push({
        sourceRef,
        sourceName: sourceNode?.name ?? sourceRef,
        relation: edge.relation,
        sourceEntry: sourceNode?.nodeType === "lore" ? sourceNode : null,
        keyOnSource: toRelationshipKey(activeNode.ref),
      });
    }

    return { mutual, outgoing, incoming };
  }, [activeNode, allNodesByRef, payload.explicitEdges]);

  const mentionGroups = useMemo(() => {
    if (activeNode.nodeType === "lorebook") {
      return {
        mutual: [] as Array<{ otherRef: string; otherName: string; outEdge: LmGraphEdge; inEdge: LmGraphEdge }>,
        outgoing: [] as LmGraphEdge[],
        incoming: [] as Array<{ edge: LmGraphEdge; sourceEntry: LmEntryNode | null }>,
      };
    }

    const outByTarget = new Map<string, LmGraphEdge>();
    const inBySource = new Map<string, LmGraphEdge>();
    for (const edge of payload.mentionEdges) {
      if (edge.sourceRef === activeNode.ref) outByTarget.set(edge.targetRef, edge);
      else if (edge.targetRef === activeNode.ref) inBySource.set(edge.sourceRef, edge);
    }

    const mutual: Array<{ otherRef: string; otherName: string; outEdge: LmGraphEdge; inEdge: LmGraphEdge }> = [];
    const outgoing: LmGraphEdge[] = [];
    const matchedIn = new Set<string>();

    for (const [targetRef, outEdge] of outByTarget) {
      const inEdge = inBySource.get(targetRef);
      if (inEdge) {
        matchedIn.add(targetRef);
        mutual.push({
          otherRef: targetRef,
          otherName: allNodesByRef.get(targetRef)?.name ?? targetRef,
          outEdge,
          inEdge,
        });
      } else {
        outgoing.push(outEdge);
      }
    }

    const incoming: Array<{ edge: LmGraphEdge; sourceEntry: LmEntryNode | null }> = [];
    for (const [sourceRef, edge] of inBySource) {
      if (matchedIn.has(sourceRef)) continue;
      const sourceNode = allNodesByRef.get(sourceRef);
      incoming.push({
        edge,
        sourceEntry: sourceNode?.nodeType === "lore" ? sourceNode : null,
      });
    }

    return { mutual, outgoing, incoming };
  }, [activeNode, allNodesByRef, payload.mentionEdges]);

  const linkedEntitiesForBook = useMemo(() => {
    if (activeNode.nodeType !== "lorebook") return [];
    const summary = payload.lorebooks.find((book) => book.id === activeNode.id);
    if (!summary) return [];
    const refs = [
      ...summary.characterIds.map((id) => `char:${id}`),
      ...summary.personaIds.map((id) => `persona:${id}`),
    ];
    return refs.map((ref) => allNodesByRef.get(ref)).filter((node): node is LmGraphNode => Boolean(node));
  }, [activeNode, payload.lorebooks, allNodesByRef]);

  const loadedBookCount = useMemo(() => payload.lorebooks.filter((book) => book.loaded).length, [payload.lorebooks]);

  const linkableTargets = useMemo(() => {
    if (activeNode.nodeType !== "lore") return [];
    const existingRefs = new Set([
      ...explicitGroups.mutual.map((item) => item.otherRef),
      ...explicitGroups.outgoing.map((item) => item.targetRef),
    ]);
    return payload.nodes
      .filter(
        (candidate) =>
          candidate.nodeType !== "lorebook" && candidate.ref !== activeNode.ref && !existingRefs.has(candidate.ref),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeNode, explicitGroups, payload.nodes]);

  const addTargetNode = addTargetRef ? allNodesByRef.get(addTargetRef) : undefined;
  const canBidirectTarget = addTargetNode?.nodeType === "lore";

  const isSectionOpen = (sectionKey: string, count: number) => {
    const stateKey = `${activeNode.ref}::${sectionKey}`;
    return sectionOpenOverrides[stateKey] ?? count <= SECTION_AUTO_COLLAPSE;
  };

  const toggleSection = (sectionKey: string, currentOpen: boolean) => {
    const stateKey = `${activeNode.ref}::${sectionKey}`;
    setSectionOpenOverrides((prev) => ({ ...prev, [stateKey]: !currentOpen }));
  };

  const handlePromoteMention = async (otherRef: string) => {
    const otherNode = allNodesByRef.get(otherRef);
    const rel = relationDraft.trim() || "related_to";
    if (promoteDirection === "both") {
      if (activeNode.nodeType !== "lore" || otherNode?.nodeType !== "lore") return;
      await onBatchSaveRelationships([
        { entry: activeNode, relationships: { ...activeNode.relationships, [toRelationshipKey(otherRef)]: rel } },
        { entry: otherNode, relationships: { ...otherNode.relationships, [toRelationshipKey(activeNode.ref)]: rel } },
      ]);
      return;
    }
    if (promoteDirection === "outgoing") {
      if (activeNode.nodeType !== "lore") return;
      await onSaveRelationships(activeNode, { ...activeNode.relationships, [toRelationshipKey(otherRef)]: rel });
      return;
    }
    if (otherNode?.nodeType !== "lore") return;
    await onSaveRelationships(otherNode, { ...otherNode.relationships, [toRelationshipKey(activeNode.ref)]: rel });
  };

  const canPromoteForOther = (otherRef: string): { allowed: boolean; reason?: string } => {
    const otherNode = allNodesByRef.get(otherRef);
    if (promoteDirection === "outgoing") {
      return activeNode.nodeType === "lore"
        ? { allowed: true }
        : { allowed: false, reason: "Only lorebook entries can own links — switch direction to Other → This" };
    }
    if (promoteDirection === "incoming") {
      return otherNode?.nodeType === "lore"
        ? { allowed: true }
        : { allowed: false, reason: "Only lorebook entries can own links — switch direction to This → Other" };
    }
    return activeNode.nodeType === "lore" && otherNode?.nodeType === "lore"
      ? { allowed: true }
      : { allowed: false, reason: "Both sides must be lorebook entries for Both ways" };
  };

  const handleRemoveExplicit = async (entryNode: LmEntryNode, key: string) => {
    const nextRelationships = { ...entryNode.relationships };
    delete nextRelationships[key];
    await onSaveRelationships(entryNode, nextRelationships);
  };

  const handleAddExplicit = async () => {
    if (activeNode.nodeType !== "lore" || !addTargetRef) return;
    const rel = addRelation.trim() || "related_to";
    const targetNode = allNodesByRef.get(addTargetRef);
    if (addBothWays && targetNode?.nodeType === "lore") {
      await onBatchSaveRelationships([
        { entry: activeNode, relationships: { ...activeNode.relationships, [toRelationshipKey(addTargetRef)]: rel } },
        { entry: targetNode, relationships: { ...targetNode.relationships, [toRelationshipKey(activeNode.ref)]: rel } },
      ]);
    } else if (addFlipped && targetNode?.nodeType === "lore") {
      await onSaveRelationships(targetNode, {
        ...targetNode.relationships,
        [toRelationshipKey(activeNode.ref)]: rel,
      });
    } else {
      await onSaveRelationships(activeNode, {
        ...activeNode.relationships,
        [toRelationshipKey(addTargetRef)]: rel,
      });
    }
    setAddTargetRef("");
  };

  const handleSaveEditedLink = async () => {
    if (!editingLink) return;
    const { sourceEntry, targetEntry, sourceRef, targetRef, relation, bothWays, wasBothWays } = editingLink;
    const updates = new Map<string, { entry: LmEntryNode; relationships: Record<string, string> }>();
    const ensure = (entry: LmEntryNode) => {
      if (!updates.has(entry.ref)) {
        updates.set(entry.ref, { entry, relationships: { ...entry.relationships } });
      }
      return updates.get(entry.ref)!.relationships;
    };

    if (sourceEntry) {
      ensure(sourceEntry)[toRelationshipKey(targetRef)] = relation;
    }
    if (targetEntry) {
      const targetRels = ensure(targetEntry);
      const revKey = toRelationshipKey(sourceRef);
      if (bothWays) targetRels[revKey] = relation;
      else if (wasBothWays) delete targetRels[revKey];
    }
    if (bothWays && !wasBothWays && !sourceEntry && targetEntry) {
      ensure(targetEntry)[toRelationshipKey(sourceRef)] = relation;
    }
    await onBatchSaveRelationships([...updates.values()]);
    setEditingLink(null);
  };

  const handleFlipEditedLink = async () => {
    if (!editingLink || !editingLink.sourceEntry || !editingLink.targetEntry) return;
    const { sourceEntry, targetEntry, sourceRef, targetRef, relation } = editingLink;
    const nextSource = { ...sourceEntry.relationships };
    delete nextSource[toRelationshipKey(targetRef)];
    const nextTarget = { ...targetEntry.relationships, [toRelationshipKey(sourceRef)]: relation };
    await onBatchSaveRelationships([
      { entry: sourceEntry, relationships: nextSource },
      { entry: targetEntry, relationships: nextTarget },
    ]);
    setEditingLink(null);
  };

  const activeTags = activeNode.nodeType === "lore" ? parseTagList(activeNode.tag) : [];
  const primaryTag = activeTags[0] ?? "";
  const extraTagChoices = TAG_OVERRIDES.filter((token) => token && !activeTags.includes(token));

  const totalMentionsForActive =
    mentionGroups.mutual.length + mentionGroups.outgoing.length + mentionGroups.incoming.length;
  const totalExplicitForActive =
    explicitGroups.mutual.length + explicitGroups.outgoing.length + explicitGroups.incoming.length;

  const renderMentionRow = (key: string, otherRef: string, subtitle: string) => {
    const otherNode = allNodesByRef.get(otherRef);
    const otherName = otherNode?.name ?? otherRef;
    const preview = nodeSnippet(otherNode);
    const eligibility = canPromoteForOther(otherRef);
    const targetOwnerRef = promoteDirection === "incoming" ? otherRef : activeNode.ref;
    return (
      <div
        key={key}
        title={preview || undefined}
        className="flex items-center justify-between gap-1.5 rounded border border-dashed border-[var(--border)] px-2 py-1 text-xs"
      >
        <button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => onNavigate(otherRef)}>
          <div className="truncate">
            <span className="font-medium">{otherName}</span>
            {subtitle ? <span className="text-[0.6875rem] text-[var(--muted-foreground)]"> {subtitle}</span> : null}
          </div>
          {preview ? <div className="truncate text-[0.65rem] text-[var(--muted-foreground)]/80">{preview}</div> : null}
        </button>
        <button
          type="button"
          disabled={!eligibility.allowed || savingRef === targetOwnerRef}
          title={
            eligibility.reason ??
            (promoteDirection === "both"
              ? `${activeNode.name} ↔ ${relationDraft} ↔ ${otherName}`
              : promoteDirection === "incoming"
                ? `${otherName} — ${relationDraft} → ${activeNode.name}`
                : `${activeNode.name} — ${relationDraft} → ${otherName}`)
          }
          className="mari-chrome-control mari-chrome-control--small shrink-0 disabled:opacity-40"
          onClick={() => void handlePromoteMention(otherRef)}
        >
          Promote
        </button>
      </div>
    );
  };

  return (
    <aside
      ref={cardRef}
      data-lm-graph-card
      data-lm-graph-docked={!floating || undefined}
      data-lm-graph-floating={floating || undefined}
      style={
        floating
          ? floatPos
            ? { left: floatPos.x, top: floatPos.y }
            : { right: "0.6rem", bottom: "0.6rem" }
          : undefined
      }
      aria-label="Selected node details"
    >
      <div
        className={`flex items-start justify-between gap-2 ${floating ? "cursor-grab active:cursor-grabbing select-none" : ""}`}
        onPointerDown={(event) => {
          if (!floating || !canvasWrap || !cardRef.current) return;
          if ((event.target as Element | null)?.closest("button")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const wrapRect = canvasWrap.getBoundingClientRect();
          const cardRect = cardRef.current.getBoundingClientRect();
          dragCard.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - cardRect.left + wrapRect.left,
            offsetY: event.clientY - cardRect.top + wrapRect.top,
          };
        }}
        onPointerMove={(event) => {
          if (!dragCard.current || dragCard.current.pointerId !== event.pointerId || !canvasWrap || !cardRef.current)
            return;
          const nextX = Math.max(
            8,
            Math.min(
              canvasWrap.clientWidth - cardRef.current.offsetWidth - 8,
              event.clientX - dragCard.current.offsetX,
            ),
          );
          const nextY = Math.max(
            8,
            Math.min(
              canvasWrap.clientHeight - cardRef.current.offsetHeight - 8,
              event.clientY - dragCard.current.offsetY,
            ),
          );
          setFloatPos({ x: nextX, y: nextY });
        }}
        onPointerUp={(event) => {
          if (dragCard.current?.pointerId === event.pointerId) dragCard.current = null;
        }}
        onPointerCancel={() => {
          dragCard.current = null;
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
            <span className="inline-block size-2 rounded-full" style={{ background: nodeColour }} />
            <span className="truncate">
              {activeNode.nodeType === "lore"
                ? `${activeNode.lorebookName} · ${familyLabel}`
                : activeNode.nodeType === "lorebook"
                  ? `Lorebook · ${activeNode.entryCount} entries`
                  : activeNode.nodeType === "character"
                    ? "Character card"
                    : "Persona"}
            </span>
          </div>
          <h3 className="mt-0.5 break-words text-sm font-semibold">{activeNode.name}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={!canGoBack}
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon disabled:opacity-35"
            title="Back in inspection history"
            aria-label="Back in inspection history"
            onClick={onGoBack}
          >
            <ArrowLeft size="0.875rem" />
          </button>
          <button
            type="button"
            disabled={!canGoForward}
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon disabled:opacity-35"
            title="Forward in inspection history"
            aria-label="Forward in inspection history"
            onClick={onGoForward}
          >
            <ArrowRight size="0.875rem" />
          </button>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
            title="Focus 2-hop neighbourhood on this node"
            aria-label="Focus on this node"
            onClick={() => onFocusHere(activeNode.ref)}
          >
            <Focus size="0.875rem" />
          </button>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
            title={floating ? "Dock inspector beside graph" : "Float & drag inspector over canvas"}
            aria-label={floating ? "Dock inspector beside graph" : "Float & drag inspector over canvas"}
            onClick={onToggleFloating}
          >
            {floating ? <PanelRight size="0.875rem" /> : <Move size="0.875rem" />}
          </button>
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
            aria-label="Close inspector"
            onClick={() => onNavigate(null)}
          >
            <X size="0.875rem" />
          </button>
        </div>
      </div>

      {/* Quick inline tag/category override + multi-tag chips */}
      {activeNode.nodeType === "lore" ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem]">
            <label className="flex items-center gap-1 text-[var(--muted-foreground)]">
              <span>Tag:</span>
              <select
                aria-label="Entry primary tag override"
                disabled={savingRef === activeNode.ref}
                value={TAG_OVERRIDES.includes(primaryTag as (typeof TAG_OVERRIDES)[number]) ? primaryTag : "__custom__"}
                onChange={(event) => {
                  const nextFirst = event.target.value;
                  if (nextFirst === "__custom__") return;
                  const nextTags = nextFirst ? [nextFirst, ...activeTags.slice(1).filter((t) => t !== nextFirst)] : [];
                  void onUpdateEntry(activeNode, { tag: nextTags.join(", ") });
                }}
                className="mari-chrome-field h-6 rounded px-1.5 text-[0.6875rem] text-[var(--foreground)]"
              >
                <option value="">Untagged (auto)</option>
                <option value="lore">lore (explicit)</option>
                <option value="character">character</option>
                <option value="location">location</option>
                <option value="faction">faction</option>
                <option value="item">item</option>
                <option value="creature">creature</option>
                <option value="ability">ability</option>
                <option value="quest">quest</option>
                {primaryTag && !TAG_OVERRIDES.includes(primaryTag as (typeof TAG_OVERRIDES)[number]) ? (
                  <option value="__custom__">{primaryTag}</option>
                ) : null}
              </select>
            </label>
            {extraTagChoices.length > 0 ? (
              <select
                aria-label="Add secondary tag"
                disabled={savingRef === activeNode.ref}
                value=""
                onChange={(event) => {
                  const extra = event.target.value;
                  if (!extra) return;
                  const nextTags = [...activeTags, extra];
                  void onUpdateEntry(activeNode, { tag: nextTags.join(", ") });
                }}
                className="mari-chrome-field h-6 rounded px-1 text-[0.6875rem] text-[var(--muted-foreground)]"
              >
                <option value="">+ tag…</option>
                {extraTagChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : null}
            {!activeNode.enabled ? (
              <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                Disabled
              </span>
            ) : null}
            {activeNode.constant ? (
              <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                Constant
              </span>
            ) : null}
            {activeNode.locked ? (
              <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                Locked
              </span>
            ) : null}
          </div>
          {activeTags.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {activeTags.map((tagToken) => (
                <button
                  key={tagToken}
                  type="button"
                  disabled={savingRef === activeNode.ref}
                  title={`Remove tag "${tagToken}"`}
                  onClick={() => {
                    const remaining = activeTags.filter((t) => t !== tagToken);
                    void onUpdateEntry(activeNode, { tag: remaining.join(", ") });
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--foreground)] hover:bg-[var(--accent)]/40"
                >
                  <span>{tagToken}</span>
                  <X size="0.6rem" />
                </button>
              ))}
            </div>
          ) : null}
          {activeNode.inferredFamily ? (
            <p className="text-[0.625rem] text-[var(--muted-foreground)]">
              Hatched hint from {activeNode.lorebookCategory} book — pick <strong>lore (explicit)</strong> or another
              tag.
            </p>
          ) : null}
        </div>
      ) : null}

      {activeNode.description || (activeNode.nodeType === "lore" && activeNode.content) ? (
        <p className="line-clamp-4 text-xs text-[var(--muted-foreground)]">
          {activeNode.description || (activeNode.nodeType === "lore" ? activeNode.content : "")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {activeNode.nodeType === "lore" || activeNode.description ? (
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            onClick={() => onOpenReader(activeNode, "read")}
          >
            <FileText size="0.75rem" />
            Read full
          </button>
        ) : null}
        {activeNode.nodeType === "lore" ? (
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            onClick={() => onOpenReader(activeNode, "edit")}
          >
            <Pencil size="0.75rem" />
            Edit
          </button>
        ) : null}
        {onOpenLorebook && (activeNode.nodeType === "lore" || activeNode.nodeType === "lorebook") ? (
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            onClick={() => onOpenLorebook(activeNode.nodeType === "lore" ? activeNode.lorebookId : activeNode.id)}
          >
            <ExternalLink size="0.75rem" />
            Open lorebook
          </button>
        ) : null}
        {activeNode.nodeType === "lorebook" ? (
          <button
            type="button"
            className="mari-chrome-control mari-chrome-control--small"
            onClick={() => onToggleCollapseLorebook(activeNode.id)}
          >
            {activeNode.collapsed ? <Maximize2 size="0.75rem" /> : <Minimize2 size="0.75rem" />}
            {activeNode.collapsed ? "Expand entries" : "Collapse into hub"}
          </button>
        ) : null}
      </div>

      {activeNode.nodeType === "lore" && (activeNode.keys.length > 0 || activeNode.secondaryKeys.length > 0) ? (
        <div className="space-y-1">
          {activeNode.keys.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {activeNode.keys.map((key) => (
                <span
                  key={`k-${key}`}
                  className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
                >
                  {key}
                </span>
              ))}
            </div>
          ) : null}
          {activeNode.secondaryKeys.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[0.625rem] text-[var(--muted-foreground)]">Secondary:</span>
              {activeNode.secondaryKeys.map((key) => (
                <span
                  key={`sk-${key}`}
                  className="rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
                >
                  {key}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {(activeNode.nodeType === "character" || activeNode.nodeType === "persona") && activeNode.aliases.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[0.625rem] text-[var(--muted-foreground)]">Aliases:</span>
          {activeNode.aliases.map((alias) => (
            <span
              key={alias}
              className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
            >
              {alias}
            </span>
          ))}
        </div>
      ) : null}

      {activeNode.nodeType === "lorebook" && linkedEntitiesForBook.length > 0 ? (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
          <span className="block text-xs font-medium">Linked Cards & Personas ({linkedEntitiesForBook.length})</span>
          <div className="flex flex-col gap-1">
            {linkedEntitiesForBook.map((entity) => (
              <button
                key={entity.ref}
                type="button"
                className="truncate rounded border border-[var(--border)] px-2 py-1 text-left text-xs hover:bg-[var(--accent)]/30"
                onClick={() => onNavigate(entity.ref)}
              >
                <span className="font-medium">{entity.name}</span>
                <span className="text-[var(--muted-foreground)]"> ({entity.nodeType})</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Explicit ID links */}
      <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
        <div className="flex items-center justify-between text-xs font-medium">
          <span>ID links ({totalExplicitForActive})</span>
          <span className="text-[0.6875rem] text-[var(--muted-foreground)]">Solid · relation-colored</span>
        </div>
        {totalExplicitForActive === 0 ? (
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">No explicit ID links yet.</p>
        ) : (
          <div className="space-y-1.5">
            <CollapsibleSection
              title="Mutual ↔"
              count={explicitGroups.mutual.length}
              open={isSectionOpen("exp-mutual", explicitGroups.mutual.length)}
              onToggle={() => toggleSection("exp-mutual", isSectionOpen("exp-mutual", explicitGroups.mutual.length))}
            >
              {explicitGroups.mutual.map((item) => {
                const rowId = `mut-${item.outKey}`;
                const isEditing = editingLink?.id === rowId;
                return (
                  <div key={rowId} className="space-y-1 rounded border border-[var(--border)] px-2 py-1 text-xs">
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        onClick={() => onNavigate(item.otherRef)}
                      >
                        <span className="font-medium">{item.otherName}</span>
                        <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                          {" "}
                          ({item.outRel} ↔ {item.inRel})
                        </span>
                      </button>
                      {activeNode.nodeType === "lore" ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            className="p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            aria-label={`Edit link to ${item.otherName}`}
                            onClick={() =>
                              setEditingLink({
                                id: rowId,
                                sourceEntry: activeNode,
                                targetEntry: item.otherEntry,
                                sourceRef: activeNode.ref,
                                targetRef: item.otherRef,
                                relation: item.outRel,
                                bothWays: true,
                                wasBothWays: true,
                              })
                            }
                          >
                            <Pencil size="0.72rem" />
                          </button>
                          <button
                            type="button"
                            disabled={savingRef === activeNode.ref}
                            className="p-1 text-[var(--destructive)] disabled:opacity-40"
                            aria-label={`Remove link to ${item.otherName}`}
                            onClick={() => void handleRemoveExplicit(activeNode, item.outKey)}
                          >
                            <Trash2 size="0.75rem" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {isEditing && editingLink ? (
                      <div className="flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-1.5 text-[0.6875rem]">
                        <select
                          aria-label="Edit relation type"
                          value={editingLink.relation}
                          onChange={(event) => setEditingLink({ ...editingLink, relation: event.target.value })}
                          className="mari-chrome-field h-6 flex-1 rounded px-1 text-[0.6875rem]"
                        >
                          {RELATION_PRESETS.map((rel) => (
                            <option key={rel} value={rel}>
                              {rel}
                            </option>
                          ))}
                        </select>
                        {editingLink.targetEntry ? (
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={editingLink.bothWays}
                              onChange={(event) => setEditingLink({ ...editingLink, bothWays: event.target.checked })}
                            />
                            <span>Both ways</span>
                          </label>
                        ) : null}
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => void handleSaveEditedLink()}
                        >
                          <Check size="0.7rem" />
                          Save
                        </button>
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => setEditingLink(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </CollapsibleSection>

            <CollapsibleSection
              title="From this entry →"
              count={explicitGroups.outgoing.length}
              open={isSectionOpen("exp-out", explicitGroups.outgoing.length)}
              onToggle={() => toggleSection("exp-out", isSectionOpen("exp-out", explicitGroups.outgoing.length))}
            >
              {explicitGroups.outgoing.map((item) => {
                const rowId = `out-${item.key}`;
                const isEditing = editingLink?.id === rowId;
                const targetNode = allNodesByRef.get(item.targetRef);
                const targetEntry = targetNode?.nodeType === "lore" ? targetNode : null;
                return (
                  <div key={rowId} className="space-y-1 rounded border border-[var(--border)] px-2 py-1 text-xs">
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        onClick={() => onNavigate(item.targetRef)}
                      >
                        <span className="text-[var(--muted-foreground)]">{item.relation} → </span>
                        <span className="font-medium">{item.targetName}</span>
                      </button>
                      {activeNode.nodeType === "lore" ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            className="p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            aria-label={`Edit link to ${item.targetName}`}
                            onClick={() =>
                              setEditingLink({
                                id: rowId,
                                sourceEntry: activeNode,
                                targetEntry,
                                sourceRef: activeNode.ref,
                                targetRef: item.targetRef,
                                relation: item.relation,
                                bothWays: false,
                                wasBothWays: false,
                              })
                            }
                          >
                            <Pencil size="0.72rem" />
                          </button>
                          <button
                            type="button"
                            disabled={savingRef === activeNode.ref}
                            className="p-1 text-[var(--destructive)] disabled:opacity-40"
                            aria-label={`Remove link to ${item.targetName}`}
                            onClick={() => void handleRemoveExplicit(activeNode, item.key)}
                          >
                            <Trash2 size="0.75rem" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {isEditing && editingLink ? (
                      <div className="flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-1.5 text-[0.6875rem]">
                        <select
                          aria-label="Edit relation type"
                          value={editingLink.relation}
                          onChange={(event) => setEditingLink({ ...editingLink, relation: event.target.value })}
                          className="mari-chrome-field h-6 flex-1 rounded px-1 text-[0.6875rem]"
                        >
                          {RELATION_PRESETS.map((rel) => (
                            <option key={rel} value={rel}>
                              {rel}
                            </option>
                          ))}
                        </select>
                        {editingLink.targetEntry ? (
                          <>
                            <button
                              type="button"
                              title="Flip direction (make other entry own the link)"
                              className="mari-chrome-control mari-chrome-control--small"
                              onClick={() => void handleFlipEditedLink()}
                            >
                              <ArrowLeftRight size="0.7rem" />
                              Flip
                            </button>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={editingLink.bothWays}
                                onChange={(event) => setEditingLink({ ...editingLink, bothWays: event.target.checked })}
                              />
                              <span>Both ways</span>
                            </label>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => void handleSaveEditedLink()}
                        >
                          <Check size="0.7rem" />
                          Save
                        </button>
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => setEditingLink(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </CollapsibleSection>

            <CollapsibleSection
              title="Linking to this ←"
              count={explicitGroups.incoming.length}
              open={isSectionOpen("exp-in", explicitGroups.incoming.length)}
              onToggle={() => toggleSection("exp-in", isSectionOpen("exp-in", explicitGroups.incoming.length))}
            >
              {explicitGroups.incoming.map((item) => {
                const rowId = `in-${item.sourceRef}`;
                const isEditing = editingLink?.id === rowId;
                return (
                  <div key={rowId} className="space-y-1 rounded border border-[var(--border)] px-2 py-1 text-xs">
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        onClick={() => onNavigate(item.sourceRef)}
                      >
                        <span className="font-medium">{item.sourceName}</span>
                        <span className="text-[var(--muted-foreground)]"> — {item.relation} → this</span>
                      </button>
                      {item.sourceEntry ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            className="p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            aria-label={`Edit link from ${item.sourceName}`}
                            onClick={() =>
                              setEditingLink({
                                id: rowId,
                                sourceEntry: item.sourceEntry,
                                targetEntry: activeNode.nodeType === "lore" ? activeNode : null,
                                sourceRef: item.sourceRef,
                                targetRef: activeNode.ref,
                                relation: item.relation,
                                bothWays: false,
                                wasBothWays: false,
                              })
                            }
                          >
                            <Pencil size="0.72rem" />
                          </button>
                          <button
                            type="button"
                            disabled={savingRef === item.sourceEntry.ref}
                            className="p-1 text-[var(--destructive)] disabled:opacity-40"
                            aria-label={`Remove incoming link from ${item.sourceName}`}
                            onClick={() => void handleRemoveExplicit(item.sourceEntry!, item.keyOnSource)}
                          >
                            <Trash2 size="0.75rem" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {isEditing && editingLink ? (
                      <div className="flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-1.5 text-[0.6875rem]">
                        <select
                          aria-label="Edit relation type"
                          value={editingLink.relation}
                          onChange={(event) => setEditingLink({ ...editingLink, relation: event.target.value })}
                          className="mari-chrome-field h-6 flex-1 rounded px-1 text-[0.6875rem]"
                        >
                          {RELATION_PRESETS.map((rel) => (
                            <option key={rel} value={rel}>
                              {rel}
                            </option>
                          ))}
                        </select>
                        {editingLink.targetEntry ? (
                          <>
                            <button
                              type="button"
                              title="Flip direction"
                              className="mari-chrome-control mari-chrome-control--small"
                              onClick={() => void handleFlipEditedLink()}
                            >
                              <ArrowLeftRight size="0.7rem" />
                              Flip
                            </button>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={editingLink.bothWays}
                                onChange={(event) => setEditingLink({ ...editingLink, bothWays: event.target.checked })}
                              />
                              <span>Both ways</span>
                            </label>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => void handleSaveEditedLink()}
                        >
                          <Check size="0.7rem" />
                          Save
                        </button>
                        <button
                          type="button"
                          className="mari-chrome-control mari-chrome-control--small"
                          onClick={() => setEditingLink(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </CollapsibleSection>
          </div>
        )}
      </div>

      {/* Add ID link directly beside ID links */}
      {activeNode.nodeType === "lore" && linkableTargets.length > 0 ? (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
          <span className="block text-xs font-medium">Add ID link</span>
          <div className="flex gap-1.5">
            <select
              aria-label="Target entity"
              value={addTargetRef}
              onChange={(event) => {
                setAddTargetRef(event.target.value);
                setAddFlipped(false);
              }}
              className="mari-chrome-field min-w-0 flex-1 rounded px-2 py-1 text-xs"
            >
              <option value="">Pick entry, card, or persona…</option>
              {linkableTargets.map((target) => {
                const suffix =
                  target.nodeType === "lore"
                    ? loadedBookCount > 1
                      ? ` · ${target.lorebookName}`
                      : ""
                    : target.nodeType === "character"
                      ? " · Card"
                      : " · Persona";
                return (
                  <option key={target.ref} value={target.ref}>
                    {target.name}
                    {suffix}
                  </option>
                );
              })}
            </select>
            <select
              aria-label="New link relation"
              value={addRelation}
              onChange={(event) => {
                const nextRel = event.target.value;
                setAddRelation(nextRel);
                setAddBothWays(SYMMETRIC_RELATIONS.has(nextRel));
              }}
              className="mari-chrome-field w-28 rounded px-1.5 py-1 text-xs"
            >
              {RELATION_PRESETS.map((rel) => (
                <option key={rel} value={rel}>
                  {rel}
                </option>
              ))}
            </select>
          </div>
          {addTargetNode ? (
            <div className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-[var(--border)] bg-[var(--background)]/40 px-2 py-1 text-[0.6875rem]">
              <span className="min-w-0 truncate text-[var(--muted-foreground)]">
                {addBothWays && canBidirectTarget ? (
                  <>
                    <strong className="text-[var(--foreground)]">{activeNode.name}</strong> ↔ {addRelation} ↔{" "}
                    <strong className="text-[var(--foreground)]">{addTargetNode.name}</strong>
                  </>
                ) : addFlipped && canBidirectTarget ? (
                  <>
                    <strong className="text-[var(--foreground)]">{addTargetNode.name}</strong> — {addRelation} →{" "}
                    <strong className="text-[var(--foreground)]">{activeNode.name}</strong>
                  </>
                ) : (
                  <>
                    <strong className="text-[var(--foreground)]">{activeNode.name}</strong> — {addRelation} →{" "}
                    <strong className="text-[var(--foreground)]">{addTargetNode.name}</strong>
                  </>
                )}
              </span>
              {canBidirectTarget ? (
                <div className="flex shrink-0 items-center gap-2">
                  {!addBothWays ? (
                    <button
                      type="button"
                      className="mari-chrome-control mari-chrome-control--small"
                      onClick={() => setAddFlipped((v) => !v)}
                    >
                      <ArrowLeftRight size="0.7rem" />
                      Flip
                    </button>
                  ) : null}
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={addBothWays}
                      onChange={(event) => setAddBothWays(event.target.checked)}
                    />
                    <span>Both ways</span>
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            disabled={!addTargetRef || savingRef === activeNode.ref}
            onClick={() => void handleAddExplicit()}
            className="mari-chrome-control mari-chrome-control--small w-full justify-center disabled:opacity-50"
          >
            <Link2 size="0.75rem" />
            Link by ID
          </button>
        </div>
      ) : null}

      {/* Detected mentions */}
      {activeNode.nodeType !== "lorebook" ? (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs font-medium">
            <span>Detected mentions ({totalMentionsForActive})</span>
            <label className="flex items-center gap-1 text-[0.6875rem] font-normal text-[var(--muted-foreground)]">
              <span>Promote as:</span>
              <select
                aria-label="Promote mention as relation"
                value={relationDraft}
                onChange={(event) => {
                  const nextRel = event.target.value;
                  setRelationDraft(nextRel);
                  if (SYMMETRIC_RELATIONS.has(nextRel)) setPromoteDirection("both");
                  else setPromoteDirection((curr) => (curr === "both" ? "outgoing" : curr));
                }}
                className="mari-chrome-field h-6 rounded px-1 text-[0.6875rem] text-[var(--foreground)]"
              >
                {RELATION_PRESETS.map((rel) => (
                  <option key={rel} value={rel}>
                    {rel}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {totalMentionsForActive > 0 ? (
            <div className="space-y-1">
              <div className="grid grid-cols-3 gap-1">
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small justify-center text-[0.6875rem]"
                  aria-pressed={promoteDirection === "outgoing"}
                  onClick={() => setPromoteDirection("outgoing")}
                >
                  This → Other
                </button>
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small justify-center text-[0.6875rem]"
                  aria-pressed={promoteDirection === "incoming"}
                  onClick={() => setPromoteDirection("incoming")}
                >
                  Other → This
                </button>
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small justify-center text-[0.6875rem]"
                  aria-pressed={promoteDirection === "both"}
                  onClick={() => setPromoteDirection("both")}
                >
                  Both ↔
                </button>
              </div>
              <div className="truncate rounded bg-[var(--background)]/40 px-2 py-0.5 text-[0.65rem] text-[var(--muted-foreground)]">
                {promoteDirection === "both" ? (
                  <>
                    Creates: <strong className="text-[var(--foreground)]">{activeNode.name}</strong> ↔ {relationDraft} ↔
                    Other
                  </>
                ) : promoteDirection === "incoming" ? (
                  <>
                    Creates: Other — {relationDraft} →{" "}
                    <strong className="text-[var(--foreground)]">{activeNode.name}</strong>
                  </>
                ) : (
                  <>
                    Creates: <strong className="text-[var(--foreground)]">{activeNode.name}</strong> — {relationDraft} →
                    Other
                  </>
                )}
              </div>
            </div>
          ) : null}

          {totalMentionsForActive === 0 ? (
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">No unlinked mentions detected.</p>
          ) : (
            <div className="space-y-1.5">
              <CollapsibleSection
                title="Mutual mentions ↔"
                count={mentionGroups.mutual.length}
                open={isSectionOpen("men-mutual", mentionGroups.mutual.length)}
                onToggle={() => toggleSection("men-mutual", isSectionOpen("men-mutual", mentionGroups.mutual.length))}
              >
                {mentionGroups.mutual.map((item) =>
                  renderMentionRow(
                    `mm-${item.otherRef}`,
                    item.otherRef,
                    `("${item.outEdge.matchedText}" ↔ "${item.inEdge.matchedText}")`,
                  ),
                )}
              </CollapsibleSection>

              <CollapsibleSection
                title="This entry mentions →"
                count={mentionGroups.outgoing.length}
                open={isSectionOpen("men-out", mentionGroups.outgoing.length)}
                onToggle={() => toggleSection("men-out", isSectionOpen("men-out", mentionGroups.outgoing.length))}
              >
                {mentionGroups.outgoing.map((edge, index) =>
                  renderMentionRow(
                    `mo-${edge.targetRef}|${index}`,
                    edge.targetRef,
                    edge.matchedText ? `(matches "${edge.matchedText}")` : "",
                  ),
                )}
              </CollapsibleSection>

              <CollapsibleSection
                title="Mentioned by ←"
                count={mentionGroups.incoming.length}
                open={isSectionOpen("men-in", mentionGroups.incoming.length)}
                onToggle={() => toggleSection("men-in", isSectionOpen("men-in", mentionGroups.incoming.length))}
              >
                {mentionGroups.incoming.map(({ edge }, index) =>
                  renderMentionRow(
                    `mi-${edge.sourceRef}|${index}`,
                    edge.sourceRef,
                    edge.matchedText ? `(uses "${edge.matchedText}")` : "",
                  ),
                )}
              </CollapsibleSection>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
