import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Compass,
  Focus,
  Link2,
  LocateFixed,
  MapPin,
  Maximize,
  Minimize,
  Minus,
  Package,
  Plus,
  ScrollText,
  Shield,
  Sparkles,
  Trash2,
  User,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  parseEntityRef,
  toRelationshipKey,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  buildLorebookGraph,
  defaultFocus,
  layoutGraph,
  neighbourhood,
  nodeAtPoint,
  pinchView,
  type GraphPoint,
  type GraphView,
} from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import {
  ENTITY_FAMILIES,
  type EntityFamily,
  type LmEntryNode,
  type LmGraphEdge,
  type LmGraphNode,
  type LmGraphPayload,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";

const FOCUS_HOPS = 2;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 4;
const FIT_MAX_ZOOM = 2;
const FIT_PADDING = 64;
const LABEL_LIMIT = 28;
const LABEL_ALL_LIMIT = 45;
const LABEL_ZOOM = 1.4;
const NODE_LABEL_SIZE = 11;
const TAP_TARGET = 44;
const TAP_SLOP = 8;
const NODE_MIN_ZOOM = 0.6;
const NODE_MAX_ZOOM = 1.3;
const ARROW_EXPLICIT_ID = "lm-graph-arrow-explicit";
const ARROW_EXPLICIT_LIT_ID = "lm-graph-arrow-explicit-lit";

export const RELATION_PRESETS = [
  "related_to",
  "located_in",
  "member_of",
  "ally_of",
  "rival_of",
  "owns",
  "part_of",
] as const;

export const FAMILY_META: Record<EntityFamily, { label: string; icon: LucideIcon }> = {
  character: { label: "Characters", icon: User },
  location: { label: "Locations", icon: MapPin },
  faction: { label: "Factions", icon: Shield },
  item: { label: "Items", icon: Package },
  quest: { label: "Quests", icon: Compass },
  lore: { label: "Lore", icon: BookOpen },
};

const nodeScreenScale = (k: number) => Math.min(NODE_MAX_ZOOM, Math.max(NODE_MIN_ZOOM, k));
const nodeScale = (k: number) => nodeScreenScale(k) / k;
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function nodeRadius(node: LmGraphNode & { degree: number }): number {
  const base = node.nodeType === "character" ? 13 : node.nodeType === "persona" ? 12.5 : 10;
  return base + Math.min(4, node.degree * 0.5);
}

function nodeIcon(node: LmGraphNode): LucideIcon {
  if (node.nodeType === "persona") return UserCheck;
  if (node.nodeType === "character") return User;
  return FAMILY_META[node.family]?.icon ?? ScrollText;
}

const familyColour = (family: EntityFamily) => `var(--lm-graph-${family})`;

export const GRAPH_STYLE = `
[data-lm-graph] {
  --lm-graph-character: #3b82f6;
  --lm-graph-location: #16a56e;
  --lm-graph-faction: #ef4444;
  --lm-graph-item: #d97706;
  --lm-graph-quest: #8b5cf6;
  --lm-graph-lore: #64748b;
  --lm-graph-canvas: color-mix(in srgb, var(--background) 94%, var(--primary) 2%);
  --lm-graph-grid-dot: color-mix(in srgb, var(--foreground) 12%, transparent);
  --lm-graph-surface: #ffffff;
  --lm-graph-edge: color-mix(in srgb, var(--foreground) 34%, transparent);
  --lm-graph-mention: color-mix(in srgb, var(--foreground) 20%, transparent);
  --lm-graph-ink: var(--foreground);
  --lm-graph-divider: color-mix(in srgb, var(--primary) 14%, transparent);
  --lm-graph-overlay-shadow: 0 10px 30px -12px rgb(26 16 37 / 0.35), 0 2px 6px -2px rgb(26 16 37 / 0.18);
}
[data-theme="dark"] [data-lm-graph] {
  --lm-graph-character: #60a5fa;
  --lm-graph-location: #34d399;
  --lm-graph-faction: #f87171;
  --lm-graph-item: #fbbf24;
  --lm-graph-quest: #a78bfa;
  --lm-graph-lore: #94a3b8;
  --lm-graph-canvas: #0b0a16;
  --lm-graph-surface: #141226;
  --lm-graph-overlay-shadow: 0 12px 32px -10px rgb(0 0 0 / 0.7), 0 2px 8px -2px rgb(0 0 0 / 0.5);
}
[data-lm-graph-canvas] {
  height: clamp(26rem, 64vh, 42rem);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background-color: var(--lm-graph-canvas);
  background-image: radial-gradient(var(--lm-graph-grid-dot) 1px, transparent 1.2px);
  background-size: 22px 22px;
}
[data-lm-graph-divider] {
  align-self: center;
  width: 1px;
  height: 1.25rem;
  background: var(--lm-graph-divider);
}
[data-lm-graph-zoom] {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  z-index: 1;
  display: grid;
  gap: 0.25rem;
}
[data-lm-graph-zoom] > * {
  box-shadow: var(--lm-graph-overlay-shadow);
}
[data-lm-graph-banner] {
  position: absolute;
  top: 0.6rem;
  left: 50%;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.375rem 0.625rem;
  max-width: calc(100% - 7rem);
  padding: 0.375rem 0.5rem 0.375rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--card);
  box-shadow: var(--lm-graph-overlay-shadow);
  font-size: 0.8125rem;
  transform: translateX(-50%);
}
[data-lm-graph-card] {
  position: absolute;
  right: 0.6rem;
  bottom: 0.6rem;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  width: 22rem;
  max-height: calc(100% - 1.2rem);
  padding: 0.875rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--card);
  box-shadow: var(--lm-graph-overlay-shadow);
}
[data-lm-graph-has-banner] [data-lm-graph-card] {
  max-height: calc(100% - 4.25rem);
}
[data-lm-graph-pointing] [data-lm-graph-node]:not([data-lm-graph-near]) {
  opacity: 0.2;
}
[data-lm-graph-expanded] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  grid-template-rows: auto minmax(0, 1fr) auto;
  padding: max(0.75rem, env(safe-area-inset-top, 0px)) max(0.75rem, env(safe-area-inset-right, 0px))
    max(0.75rem, env(safe-area-inset-bottom, 0px)) max(0.75rem, env(safe-area-inset-left, 0px));
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--background);
}
[data-lm-graph-expanded] [data-lm-graph-canvas] {
  height: auto;
  min-height: 0;
}
@media (max-width: 52rem) {
  [data-lm-graph-card],
  [data-lm-graph-has-banner] [data-lm-graph-card] {
    right: 0.5rem;
    bottom: 0.5rem;
    left: 0.5rem;
    width: auto;
    max-height: min(48%, 22rem);
  }
  [data-lm-graph-canvas] {
    height: min(60svh, 34rem);
  }
  [data-lm-graph-divider] {
    display: none;
  }
  [data-lm-graph-banner] {
    right: 3rem;
    left: 0.5rem;
    justify-content: flex-start;
    max-width: none;
    transform: none;
  }
}
`;

type NodeActions = {
  register: (ref: string, element: SVGGElement | null) => void;
  hover: (ref: string | null, from?: string) => void;
  open: (ref: string) => void;
  focusHere: (ref: string) => void;
};

type GraphNodeViewProps = {
  node: LmGraphNode & { degree: number };
  title: string;
  near: boolean;
  lit: boolean;
  selected: boolean;
  showLabel: boolean;
  actions: NodeActions;
};

const GraphNodeView = memo(function GraphNodeView({
  node,
  title,
  near,
  lit,
  selected,
  showLabel,
  actions,
}: GraphNodeViewProps) {
  const radius = nodeRadius(node);
  const Icon = nodeIcon(node);
  const colour = familyColour(node.family);
  const isCardOrPersona = node.nodeType === "character" || node.nodeType === "persona";
  const disabled = node.nodeType === "lore" && !node.enabled;

  return (
    <g
      ref={(element) => actions.register(node.ref, element)}
      role="button"
      tabIndex={0}
      aria-label={`${node.name} (${node.nodeType === "lore" ? node.family : node.nodeType})`}
      opacity={disabled ? 0.5 : 1}
      style={{ cursor: "pointer", outline: "none" }}
      data-lm-graph-node={node.ref}
      data-lm-graph-near={near || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") actions.hover(node.ref);
      }}
      onPointerLeave={() => actions.hover(null, node.ref)}
      onClick={() => actions.open(node.ref)}
      onDoubleClick={() => actions.focusHere(node.ref)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.open(node.ref);
        }
      }}
    >
      {selected ? (
        <circle
          r={radius + 4}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {isCardOrPersona ? (
        <circle
          r={radius + 2}
          fill="none"
          stroke={colour}
          strokeWidth={1.2}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <circle
        r={radius}
        fill={`color-mix(in srgb, ${colour} 22%, var(--lm-graph-surface))`}
        stroke={colour}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <Icon
        aria-hidden="true"
        x={-radius * 0.55}
        y={-radius * 0.55}
        width={radius * 1.1}
        height={radius * 1.1}
        stroke={colour}
      />
      {showLabel ? (
        <text
          y={14}
          textAnchor="middle"
          fontSize={NODE_LABEL_SIZE}
          fontWeight={lit || selected ? 650 : undefined}
          fill="var(--foreground)"
          stroke="var(--lm-graph-canvas)"
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
          pointerEvents="none"
          data-lm-graph-label
        >
          {title}
        </text>
      ) : null}
    </g>
  );
});

export interface LorebookGraphProps {
  payload: LmGraphPayload;
  selectedLorebookIds: ReadonlySet<string>;
  search: string;
  selectedNodeRef: string | null;
  onSelectNodeRef: (ref: string | null) => void;
  savingRef: string | null;
  onSaveRelationships: (entry: LmEntryNode, nextRelationships: Record<string, string>) => Promise<void>;
}

export function LorebookGraph({
  payload,
  selectedLorebookIds,
  search,
  selectedNodeRef,
  onSelectNodeRef,
  savingRef,
  onSaveRelationships,
}: LorebookGraphProps) {
  const [whole, setWhole] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [hiddenFamilies, setHiddenFamilies] = useState<ReadonlySet<EntityFamily>>(() => new Set());
  const [showCharacters, setShowCharacters] = useState(true);
  const [showPersonas, setShowPersonas] = useState(true);
  const [showExplicit, setShowExplicit] = useState(true);
  const [showMentions, setShowMentions] = useState(true);
  const [focusPick, setFocusPick] = useState<string | null>(null);
  const [hoverRef, setHoverRef] = useState<string | null>(null);
  const [view, setView] = useState<GraphView>({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [relationDraft, setRelationDraft] = useState<string>("related_to");
  const [addTargetRef, setAddTargetRef] = useState<string>("");
  const [addRelation, setAddRelation] = useState<string>("related_to");

  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const pointers = useRef(new Map<number, GraphPoint>());
  const press = useRef({ start: { x: 0, y: 0 }, moved: false });

  const graph = useMemo(
    () =>
      buildLorebookGraph(payload, {
        lorebookIds: selectedLorebookIds,
        hiddenFamilies,
        showCharacters,
        showPersonas,
        showExplicit,
        showMentions,
        search,
      }),
    [payload, selectedLorebookIds, hiddenFamilies, showCharacters, showPersonas, showExplicit, showMentions, search],
  );

  const nodesByRef = useMemo(() => new Map(graph.nodes.map((node) => [node.ref, node])), [graph.nodes]);
  const allNodesByRef = useMemo(() => new Map(payload.nodes.map((node) => [node.ref, node])), [payload.nodes]);

  const focusRef = useMemo(
    () => (focusPick && nodesByRef.has(focusPick) ? focusPick : defaultFocus(graph, selectedNodeRef)),
    [focusPick, nodesByRef, graph, selectedNodeRef],
  );

  const shown = useMemo(() => {
    if (whole || !focusRef) return graph;
    const ids = neighbourhood(graph, focusRef, FOCUS_HOPS);
    return {
      nodes: graph.nodes.filter((node) => ids.has(node.ref)),
      edges: graph.edges.filter((edge) => ids.has(edge.sourceRef) && ids.has(edge.targetRef)),
    };
  }, [graph, whole, focusRef]);

  const positions = useMemo(() => layoutGraph(shown).positions, [shown]);
  const shownRefs = useMemo(() => new Set(shown.nodes.map((node) => node.ref)), [shown.nodes]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (from: string, to: string) => map.set(from, (map.get(from) ?? new Set()).add(to));
    for (const edge of shown.edges) {
      add(edge.sourceRef, edge.targetRef);
      add(edge.targetRef, edge.sourceRef);
    }
    return map;
  }, [shown.edges]);

  useLayoutEffect(() => {
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = Math.round(wrap.clientWidth);
      const h = Math.round(wrap.clientHeight);
      if (w > 0 && h > 0) setSize((current) => (current.w === w && current.h === h ? current : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [wrap]);

  const fit = useCallback(() => {
    const points = [...positions.values()];
    if (!points.length) return;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const k = Math.min(
      FIT_MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(size.w / (maxX - minX + 2 * FIT_PADDING), size.h / (maxY - minY + 2 * FIT_PADDING))),
    );
    setView({ k, x: size.w / 2 - ((minX + maxX) / 2) * k, y: size.h / 2 - ((minY + maxY) / 2) * k });
  }, [positions, size.w, size.h]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  const shownKey = shown.nodes.map((node) => node.ref).join("|");
  useEffect(() => fitRef.current(), [shownKey, size.w, size.h]);

  const zoomAt = useCallback(
    (factor: number, px = size.w / 2, py = size.h / 2) =>
      setView((current) => {
        const k = clampZoom(current.k * factor);
        const ratio = k / current.k;
        return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      }),
    [size.w, size.h],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt, wrap]);

  const screenPoint = (event: { clientX: number; clientY: number }): GraphPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const nodeAt = (event: { clientX: number; clientY: number }) =>
    nodeAtPoint(
      positions,
      (ref) => {
        const node = nodesByRef.get(ref);
        return node ? nodeRadius(node) * nodeScale(view.k) : 0;
      },
      view,
      screenPoint(event),
      TAP_TARGET,
    );

  const nodeActions = useMemo<NodeActions>(
    () => ({
      register: (ref, element) => {
        if (element) nodeRefs.current.set(ref, element);
        else nodeRefs.current.delete(ref);
      },
      hover: (ref, from) => setHoverRef((current) => (ref === null && current !== from ? current : ref)),
      open: (ref) => {
        setAddTargetRef("");
        onSelectNodeRef(ref);
      },
      focusHere: (ref) => {
        setFocusPick(ref);
        setWhole(false);
      },
    }),
    [onSelectNodeRef],
  );

  const activeNode = selectedNodeRef
    ? (nodesByRef.get(selectedNodeRef) ?? allNodesByRef.get(selectedNodeRef))
    : undefined;
  const activeId = hoverRef ?? (activeNode ? activeNode.ref : null);
  const pointNear = useMemo(() => {
    if (!hoverRef) return null;
    return new Set([hoverRef, ...(adjacency.get(hoverRef) ?? [])]);
  }, [hoverRef, adjacency]);
  const activeNear = useMemo(() => {
    if (!activeId) return null;
    return new Set([activeId, ...(adjacency.get(activeId) ?? [])]);
  }, [activeId, adjacency]);

  const counts = useMemo(() => {
    const familyCounts = new Map<EntityFamily, number>();
    const filterByBooks = selectedLorebookIds.size > 0;
    for (const node of payload.nodes) {
      if (node.nodeType === "lore" && filterByBooks && !selectedLorebookIds.has(node.lorebookId)) continue;
      if (node.nodeType === "character" && !showCharacters) continue;
      if (node.nodeType === "persona" && !showPersonas) continue;
      familyCounts.set(node.family, (familyCounts.get(node.family) ?? 0) + 1);
    }
    return familyCounts;
  }, [payload.nodes, selectedLorebookIds, showCharacters, showPersonas]);

  const edgeScale = nodeScale(view.k);
  const labelEveryNode = shown.nodes.length <= LABEL_ALL_LIMIT || view.k >= LABEL_ZOOM;

  const edgeLayer = useMemo(
    () =>
      shown.edges.map((edge, index) => {
        const from = positions.get(edge.sourceRef);
        const to = positions.get(edge.targetRef);
        const fromNode = nodesByRef.get(edge.sourceRef);
        const toNode = nodesByRef.get(edge.targetRef);
        if (!from || !to || !fromNode || !toNode) return null;
        const lit = activeId !== null && (edge.sourceRef === activeId || edge.targetRef === activeId);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        const gapFrom = (nodeRadius(fromNode) + 2) * edgeScale;
        const gapTo = (nodeRadius(toNode) + 2) * edgeScale;
        const isExplicit = edge.kind === "explicit";
        return (
          <line
            key={`${edge.kind}|${edge.sourceRef}|${edge.targetRef}|${edge.relation}|${index}`}
            x1={from.x + (dx / length) * gapFrom}
            y1={from.y + (dy / length) * gapFrom}
            x2={to.x - (dx / length) * gapTo}
            y2={to.y - (dy / length) * gapTo}
            stroke={lit ? "var(--lm-graph-ink)" : isExplicit ? "var(--lm-graph-edge)" : "var(--lm-graph-mention)"}
            strokeWidth={isExplicit ? (lit ? 2 : 1.4) : 1.1}
            strokeDasharray={isExplicit ? undefined : "5 4"}
            vectorEffect="non-scaling-stroke"
            opacity={hoverRef && !(edge.sourceRef === hoverRef || edge.targetRef === hoverRef) ? 0.12 : 1}
            markerEnd={
              isExplicit && length > gapFrom + gapTo
                ? `url(#${lit ? ARROW_EXPLICIT_LIT_ID : ARROW_EXPLICIT_ID})`
                : undefined
            }
          />
        );
      }),
    [shown.edges, positions, nodesByRef, activeId, hoverRef, edgeScale],
  );

  const nodeLayer = useMemo(
    () =>
      shown.nodes.map((node) => {
        if (!positions.has(node.ref)) return null;
        const lit = activeNear?.has(node.ref) ?? false;
        const selected = node.ref === selectedNodeRef;
        return (
          <GraphNodeView
            key={node.ref}
            node={node}
            title={node.name.length > LABEL_LIMIT ? `${node.name.slice(0, LABEL_LIMIT - 1)}…` : node.name}
            near={pointNear?.has(node.ref) ?? false}
            lit={lit}
            selected={selected}
            showLabel={labelEveryNode || node.ref === focusRef || selected || lit || node.nodeType !== "lore"}
            actions={nodeActions}
          />
        );
      }),
    [shown.nodes, positions, activeNear, pointNear, selectedNodeRef, focusRef, labelEveryNode, nodeActions],
  );

  const labelScale = 1 / nodeScreenScale(view.k);
  useLayoutEffect(() => {
    const write = (element: Element, value: string) => {
      if (element.getAttribute("transform") !== value) element.setAttribute("transform", value);
    };
    for (const [ref, element] of nodeRefs.current) {
      const point = positions.get(ref);
      const node = nodesByRef.get(ref);
      if (!point || !node) continue;
      write(element, `translate(${point.x} ${point.y}) scale(${edgeScale})`);
      const label = element.querySelector("[data-lm-graph-label]");
      if (label) write(label, `translate(0 ${nodeRadius(node)}) scale(${labelScale})`);
    }
  }, [nodeLayer, positions, nodesByRef, edgeScale, labelScale]);

  const toggleFamily = (family: EntityFamily) =>
    setHiddenFamilies((current) => {
      const next = new Set(current);
      if (!next.delete(family)) next.add(family);
      return next;
    });

  const activeExplicitOutgoing = useMemo(() => {
    if (!activeNode || activeNode.nodeType !== "lore") return [];
    const items: Array<{ key: string; targetRef: string; targetName: string; relation: string }> = [];
    for (const [key, relation] of Object.entries(activeNode.relationships)) {
      const parsed = parseEntityRef(key);
      if (!parsed) continue;
      items.push({
        key,
        targetRef: parsed.ref,
        targetName: allNodesByRef.get(parsed.ref)?.name ?? key,
        relation,
      });
    }
    return items;
  }, [activeNode, allNodesByRef]);

  const activeExplicitIncoming = useMemo(() => {
    if (!activeNode) return [];
    return payload.explicitEdges.filter((edge) => edge.targetRef === activeNode.ref);
  }, [activeNode, payload.explicitEdges]);

  const activeMentions = useMemo(() => {
    if (!activeNode) return [];
    return payload.mentionEdges.filter(
      (edge) => edge.sourceRef === activeNode.ref || edge.targetRef === activeNode.ref,
    );
  }, [activeNode, payload.mentionEdges]);

  const linkableTargets = useMemo(() => {
    if (!activeNode || activeNode.nodeType !== "lore") return [];
    const existingRefs = new Set(activeExplicitOutgoing.map((item) => item.targetRef));
    return payload.nodes
      .filter((candidate) => candidate.ref !== activeNode.ref && !existingRefs.has(candidate.ref))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeNode, activeExplicitOutgoing, payload.nodes]);

  const handlePromoteMention = async (edge: LmGraphEdge) => {
    const entryNode = activeNode?.nodeType === "lore" && edge.sourceRef === activeNode.ref ? activeNode : null;
    if (!entryNode) return;
    const key = toRelationshipKey(edge.targetRef);
    const nextRelationships = { ...entryNode.relationships, [key]: relationDraft.trim() || "related_to" };
    await onSaveRelationships(entryNode, nextRelationships);
  };

  const handleRemoveExplicit = async (entryNode: LmEntryNode, key: string) => {
    const nextRelationships = { ...entryNode.relationships };
    delete nextRelationships[key];
    await onSaveRelationships(entryNode, nextRelationships);
  };

  const handleAddExplicit = async () => {
    if (!activeNode || activeNode.nodeType !== "lore" || !addTargetRef) return;
    const key = toRelationshipKey(addTargetRef);
    const nextRelationships = { ...activeNode.relationships, [key]: addRelation.trim() || "related_to" };
    await onSaveRelationships(activeNode, nextRelationships);
    setAddTargetRef("");
  };

  const focusNodeName = focusRef ? allNodesByRef.get(focusRef)?.name : null;

  const content = (
    <div
      ref={rootRef}
      className="grid min-w-0 gap-3"
      data-lm-graph
      data-lm-graph-expanded={expanded || undefined}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded || undefined}
    >
      <style>{GRAPH_STYLE}</style>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={!whole}
          onClick={() => setWhole((value) => !value)}
        >
          <Focus aria-hidden="true" size="0.875rem" />
          {whole ? "Whole graph" : "Focus (2-hop)"}
        </button>

        <span aria-hidden="true" data-lm-graph-divider />

        {ENTITY_FAMILIES.map((family) => {
          const meta = FAMILY_META[family];
          const hidden = hiddenFamilies.has(family);
          return (
            <button
              key={family}
              type="button"
              className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
              aria-pressed={!hidden}
              onClick={() => toggleFamily(family)}
            >
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{
                  background: hidden ? "transparent" : familyColour(family),
                  boxShadow: hidden ? `inset 0 0 0 2px ${familyColour(family)}` : undefined,
                  opacity: hidden ? 0.65 : 1,
                }}
              />
              {meta.label}
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">{counts.get(family) ?? 0}</span>
            </button>
          );
        })}

        <span aria-hidden="true" data-lm-graph-divider />

        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={showExplicit}
          onClick={() => setShowExplicit((value) => !value)}
        >
          <Link2 aria-hidden="true" size="0.875rem" />
          ID links
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={showMentions}
          onClick={() => setShowMentions((value) => !value)}
        >
          <Sparkles aria-hidden="true" size="0.875rem" />
          Mentions
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={showCharacters}
          onClick={() => setShowCharacters((value) => !value)}
        >
          Cards
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={showPersonas}
          onClick={() => setShowPersonas((value) => !value)}
        >
          Personas
        </button>
      </div>

      {shown.nodes.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
          No nodes match the current lorebook or filter selection.
        </div>
      ) : (
        <div
          ref={setWrap}
          className="relative overflow-hidden select-none"
          data-lm-graph-canvas
          data-lm-graph-pointing={hoverRef ? "1" : undefined}
          data-lm-graph-has-banner={!whole && focusNodeName ? "1" : undefined}
        >
          {!whole && focusNodeName ? (
            <div data-lm-graph-banner>
              <span>
                Focused on <strong>{focusNodeName}</strong>
              </span>
              <button
                type="button"
                className="mari-chrome-control mari-chrome-control--small"
                onClick={() => setWhole(true)}
              >
                Show all
              </button>
            </div>
          ) : null}

          <div data-lm-graph-zoom>
            <button
              type="button"
              className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
              aria-label="Zoom in"
              onClick={() => zoomAt(1.3)}
            >
              <Plus size="0.875rem" />
            </button>
            <button
              type="button"
              className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
              aria-label="Zoom out"
              onClick={() => zoomAt(1 / 1.3)}
            >
              <Minus size="0.875rem" />
            </button>
            <button
              type="button"
              className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
              aria-label="Fit graph"
              onClick={fit}
            >
              <LocateFixed size="0.875rem" />
            </button>
            <button
              type="button"
              className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
              aria-label={expanded ? "Exit full screen" : "Full screen"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <Minimize size="0.875rem" /> : <Maximize size="0.875rem" />}
            </button>
          </div>

          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            style={{ touchAction: "none", display: "block" }}
            onPointerDown={(event) => {
              if (event.button !== 0 && event.pointerType === "mouse") return;
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = screenPoint(event);
              pointers.current.set(event.pointerId, point);
              if (pointers.current.size === 1) {
                press.current = { start: point, moved: false };
              } else {
                press.current.moved = true;
              }
            }}
            onPointerMove={(event) => {
              const prev = pointers.current.get(event.pointerId);
              if (!prev) return;
              const next = screenPoint(event);
              if (pointers.current.size === 1) {
                const dx = next.x - prev.x;
                const dy = next.y - prev.y;
                if (
                  !press.current.moved &&
                  Math.hypot(next.x - press.current.start.x, next.y - press.current.start.y) > TAP_SLOP
                ) {
                  press.current.moved = true;
                }
                if (press.current.moved) {
                  setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
                }
              } else if (pointers.current.size === 2) {
                const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
                if (other) {
                  setView((current) => pinchView(current, [prev, other], [next, other], MIN_ZOOM, MAX_ZOOM));
                }
              }
              pointers.current.set(event.pointerId, next);
            }}
            onPointerUp={(event) => {
              const wasSingle = pointers.current.size === 1;
              pointers.current.delete(event.pointerId);
              if (wasSingle && !press.current.moved) {
                const target = event.target as Element | null;
                if (!target?.closest("[data-lm-graph-node]")) {
                  const hit = nodeAt(event);
                  if (hit) onSelectNodeRef(hit);
                  else onSelectNodeRef(null);
                }
              }
            }}
            onPointerCancel={(event) => {
              pointers.current.delete(event.pointerId);
            }}
          >
            <defs>
              <marker
                id={ARROW_EXPLICIT_ID}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--lm-graph-edge)" />
              </marker>
              <marker
                id={ARROW_EXPLICIT_LIT_ID}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--lm-graph-ink)" />
              </marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <g>{edgeLayer}</g>
              <g>{nodeLayer}</g>
            </g>
          </svg>

          {activeNode ? (
            <aside data-lm-graph-card aria-label="Selected node details">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: familyColour(activeNode.family) }}
                    />
                    <span>
                      {activeNode.nodeType === "lore"
                        ? `${activeNode.lorebookName} · ${FAMILY_META[activeNode.family].label}`
                        : activeNode.nodeType === "character"
                          ? "Character card"
                          : "Persona"}
                    </span>
                  </div>
                  <h3 className="mt-0.5 break-words text-sm font-semibold">{activeNode.name}</h3>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
                    title="Focus on this node"
                    aria-label="Focus on this node"
                    onClick={() => {
                      setFocusPick(activeNode.ref);
                      setWhole(false);
                    }}
                  >
                    <Focus size="0.875rem" />
                  </button>
                  <button
                    type="button"
                    className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
                    aria-label="Close inspector"
                    onClick={() => onSelectNodeRef(null)}
                  >
                    <X size="0.875rem" />
                  </button>
                </div>
              </div>

              {activeNode.description || (activeNode.nodeType === "lore" && activeNode.content) ? (
                <p className="line-clamp-4 text-xs text-[var(--muted-foreground)]">
                  {activeNode.description || (activeNode.nodeType === "lore" ? activeNode.content : "")}
                </p>
              ) : null}

              {activeNode.nodeType === "lore" && activeNode.keys.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {activeNode.keys.slice(0, 6).map((key) => (
                    <span
                      key={key}
                      className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
                    >
                      {key}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>ID links ({activeExplicitOutgoing.length + activeExplicitIncoming.length})</span>
                  <span className="text-[0.6875rem] text-[var(--muted-foreground)]">Solid edges</span>
                </div>
                {activeExplicitOutgoing.length === 0 && activeExplicitIncoming.length === 0 ? (
                  <p className="text-[0.6875rem] text-[var(--muted-foreground)]">No explicit ID links yet.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {activeExplicitOutgoing.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center justify-between gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs"
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                          onClick={() => {
                            if (shownRefs.has(item.targetRef)) onSelectNodeRef(item.targetRef);
                          }}
                        >
                          <span className="text-[var(--muted-foreground)]">{item.relation} → </span>
                          <span className="font-medium">{item.targetName}</span>
                        </button>
                        {activeNode.nodeType === "lore" ? (
                          <button
                            type="button"
                            disabled={savingRef === activeNode.ref}
                            className="shrink-0 p-1 text-[var(--destructive)] disabled:opacity-40"
                            aria-label={`Remove link to ${item.targetName}`}
                            onClick={() => void handleRemoveExplicit(activeNode, item.key)}
                          >
                            <Trash2 size="0.75rem" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {activeExplicitIncoming.map((edge, idx) => (
                      <button
                        key={`${edge.sourceRef}|${idx}`}
                        type="button"
                        className="truncate rounded border border-[var(--border)] px-2 py-1 text-left text-xs hover:bg-[var(--accent)]/30"
                        onClick={() => {
                          if (shownRefs.has(edge.sourceRef)) onSelectNodeRef(edge.sourceRef);
                        }}
                      >
                        <span className="font-medium">{allNodesByRef.get(edge.sourceRef)?.name ?? edge.sourceRef}</span>
                        <span className="text-[var(--muted-foreground)]"> — {edge.relation} → this</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {activeNode.nodeType === "lore" ? (
                <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
                  <div className="flex items-center justify-between gap-2 text-xs font-medium">
                    <span>Detected mentions ({activeMentions.length})</span>
                    <select
                      aria-label="Promotion relation"
                      value={relationDraft}
                      onChange={(event) => setRelationDraft(event.target.value)}
                      className="mari-chrome-field h-6 rounded px-1.5 text-[0.6875rem]"
                    >
                      {RELATION_PRESETS.map((rel) => (
                        <option key={rel} value={rel}>
                          {rel}
                        </option>
                      ))}
                    </select>
                  </div>
                  {activeMentions.length === 0 ? (
                    <p className="text-[0.6875rem] text-[var(--muted-foreground)]">No unlinked mentions detected.</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {activeMentions.map((edge, index) => {
                        const isOutgoing = edge.sourceRef === activeNode.ref;
                        const otherRef = isOutgoing ? edge.targetRef : edge.sourceRef;
                        const otherName = allNodesByRef.get(otherRef)?.name ?? otherRef;
                        return (
                          <div
                            key={`${edge.sourceRef}|${edge.targetRef}|${index}`}
                            className="flex items-center justify-between gap-1.5 rounded border border-dashed border-[var(--border)] px-2 py-1 text-xs"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left hover:underline"
                              onClick={() => {
                                if (shownRefs.has(otherRef)) onSelectNodeRef(otherRef);
                              }}
                            >
                              <span className="font-medium">{otherName}</span>
                              {edge.matchedText ? (
                                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                                  {" "}
                                  ({isOutgoing ? `mentions "${edge.matchedText}"` : "mentions this"})
                                </span>
                              ) : null}
                            </button>
                            {isOutgoing ? (
                              <button
                                type="button"
                                disabled={savingRef === activeNode.ref}
                                className="mari-chrome-control mari-chrome-control--small shrink-0 disabled:opacity-50"
                                onClick={() => void handlePromoteMention(edge)}
                              >
                                Promote
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              {activeNode.nodeType === "lore" && linkableTargets.length > 0 ? (
                <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
                  <span className="block text-xs font-medium">Add ID link</span>
                  <div className="flex gap-1.5">
                    <select
                      aria-label="Target entity"
                      value={addTargetRef}
                      onChange={(event) => setAddTargetRef(event.target.value)}
                      className="mari-chrome-field min-w-0 flex-1 rounded px-2 py-1 text-xs"
                    >
                      <option value="">Pick entry, card, or persona…</option>
                      {linkableTargets.map((target) => (
                        <option key={target.ref} value={target.ref}>
                          {target.name} ({target.nodeType === "lore" ? target.lorebookName : target.nodeType})
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="New link relation"
                      value={addRelation}
                      onChange={(event) => setAddRelation(event.target.value)}
                      className="mari-chrome-field w-28 rounded px-1.5 py-1 text-xs"
                    >
                      {RELATION_PRESETS.map((rel) => (
                        <option key={rel} value={rel}>
                          {rel}
                        </option>
                      ))}
                    </select>
                  </div>
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
            </aside>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--muted-foreground)]">
        <span>
          {shown.nodes.length} nodes · {shown.edges.filter((e) => e.kind === "explicit").length} ID links ·{" "}
          {shown.edges.filter((e) => e.kind === "mention").length} mentions
        </span>
        <span>Solid = explicit ID link · Dashed = text mention · Double-click node to focus</span>
      </div>
    </div>
  );

  return expanded && typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
