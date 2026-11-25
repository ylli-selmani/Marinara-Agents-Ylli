import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Compass,
  EyeOff,
  Focus,
  Ghost,
  Globe,
  Link2,
  LocateFixed,
  MapPin,
  Maximize,
  Minimize,
  Minus,
  Package,
  Plus,
  RotateCcw,
  ScrollText,
  Shield,
  Sparkles,
  User,
  UserCheck,
  UserCog,
  Users,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  buildLorebookGraph,
  defaultFocus,
  LAYOUT_MAX_ITERATIONS,
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
  type LmGraphNode,
  type LmGraphPayload,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import type { LmEntryPatch } from "./api";
import { EntryReaderModal } from "./EntryReaderModal";
import { GraphInspector } from "./GraphInspector";

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
const ARROW_MENTION_ID = "lm-graph-arrow-mention";
const ARROW_MENTION_LIT_ID = "lm-graph-arrow-mention-lit";

const RELATION_COLORS: Record<string, string> = {
  ally_of: "#22c55e",
  rival_of: "#ef4444",
  located_in: "#14b8a6",
  part_of: "#a855f7",
  member_of: "#6366f1",
  owns: "#f59e0b",
};

function relationMarkerId(relation: string): string | null {
  const base = relation.split(" / ")[0]?.trim() ?? "";
  return base in RELATION_COLORS ? `lm-graph-arrow-rel-${base}` : null;
}

function relationStroke(relation: string): string {
  const base = relation.split(" / ")[0]?.trim() ?? "";
  return RELATION_COLORS[base] ?? "var(--lm-graph-ink)";
}

export const FAMILY_META: Record<EntityFamily, { label: string; icon: LucideIcon }> = {
  character: { label: "Characters", icon: User },
  location: { label: "Locations", icon: MapPin },
  faction: { label: "Factions", icon: Shield },
  item: { label: "Items", icon: Package },
  creature: { label: "Creatures", icon: Ghost },
  ability: { label: "Abilities", icon: Zap },
  quest: { label: "Quests", icon: Compass },
  lore: { label: "Lore", icon: BookOpen },
};

const nodeScreenScale = (k: number) => Math.min(NODE_MAX_ZOOM, Math.max(NODE_MIN_ZOOM, k));
const nodeScale = (k: number) => nodeScreenScale(k) / k;
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function hexPoints(radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    points.push(`${(radius * Math.cos(angle)).toFixed(2)},${(radius * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(" ");
}

function nodeRadius(node: LmGraphNode & { degree: number }): number {
  const base =
    node.nodeType === "lorebook" ? 16 : node.nodeType === "character" ? 13 : node.nodeType === "persona" ? 12.5 : 10;
  return base + Math.min(4, node.degree * 0.5);
}

function nodeIcon(node: LmGraphNode): LucideIcon {
  if (node.nodeType === "lorebook") {
    const category = node.category.trim().toLowerCase();
    if (category === "world") return Globe;
    if (category === "character") return Users;
    if (category === "npc") return UserCog;
    if (category === "spellbook") return Wand2;
    return BookOpen;
  }
  if (node.nodeType === "persona") return UserCheck;
  if (node.nodeType === "character") return User;
  return FAMILY_META[node.inferredFamily ?? node.family]?.icon ?? ScrollText;
}

const familyColour = (family: EntityFamily) => `var(--lm-graph-${family})`;

function nodeColour(node: LmGraphNode): string {
  if (node.nodeType === "lorebook") return "var(--primary)";
  if (node.nodeType === "character") return "var(--lm-graph-card)";
  if (node.nodeType === "persona") return "var(--lm-graph-persona)";
  return familyColour(node.inferredFamily ?? node.family);
}

export const GRAPH_STYLE = `
[data-lm-graph] {
  --lm-graph-character: #3b82f6;
  --lm-graph-card: #0891b2;
  --lm-graph-persona: #db2777;
  --lm-graph-location: #16a56e;
  --lm-graph-faction: #ef4444;
  --lm-graph-item: #d97706;
  --lm-graph-creature: #ea580c;
  --lm-graph-ability: #6366f1;
  --lm-graph-quest: #8b5cf6;
  --lm-graph-lore: #64748b;
  --lm-graph-canvas: color-mix(in srgb, var(--background) 94%, var(--primary) 2%);
  --lm-graph-grid-dot: color-mix(in srgb, var(--foreground) 12%, transparent);
  --lm-graph-surface: #ffffff;
  --lm-graph-edge: color-mix(in srgb, var(--foreground) 40%, transparent);
  --lm-graph-mention: color-mix(in srgb, var(--foreground) 24%, transparent);
  --lm-graph-mention-mutual: color-mix(in srgb, var(--foreground) 42%, transparent);
  --lm-graph-book-link: color-mix(in srgb, var(--primary) 55%, transparent);
  --lm-graph-ink: var(--foreground);
  --lm-graph-divider: color-mix(in srgb, var(--primary) 14%, transparent);
  --lm-graph-overlay-shadow: 0 10px 30px -12px rgb(26 16 37 / 0.35), 0 2px 6px -2px rgb(26 16 37 / 0.18);
}
[data-theme="dark"] [data-lm-graph] {
  --lm-graph-character: #60a5fa;
  --lm-graph-card: #22d3ee;
  --lm-graph-persona: #f472b6;
  --lm-graph-location: #34d399;
  --lm-graph-faction: #f87171;
  --lm-graph-item: #fbbf24;
  --lm-graph-creature: #fb923c;
  --lm-graph-ability: #818cf8;
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
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.875rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--card);
}
[data-lm-graph-card][data-lm-graph-docked] {
  width: 100%;
  max-height: clamp(24rem, 64vh, 42rem);
}
@media (min-width: 64rem) {
  [data-lm-graph-card][data-lm-graph-docked] {
    width: 24rem;
    flex-shrink: 0;
  }
}
[data-lm-graph-card][data-lm-graph-floating] {
  position: absolute;
  z-index: 3;
  width: min(24rem, calc(100% - 1.2rem));
  max-height: calc(100% - 1.2rem);
  box-shadow: var(--lm-graph-overlay-shadow);
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
[data-lm-graph-expanded] [data-lm-graph-workspace] {
  min-height: 0;
}
[data-lm-graph-expanded] [data-lm-graph-canvas],
[data-lm-graph-expanded] [data-lm-graph-card][data-lm-graph-docked] {
  height: 100%;
  max-height: 100%;
  min-height: 0;
}
@media (max-width: 52rem) {
  [data-lm-graph-card][data-lm-graph-floating] {
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
  doubleClick: (node: LmGraphNode) => void;
  pointerDownNode: (ref: string, event: React.PointerEvent<SVGGElement>) => void;
};

type GraphNodeViewProps = {
  node: LmGraphNode & { degree: number };
  title: string;
  near: boolean;
  lit: boolean;
  selected: boolean;
  pinned: boolean;
  showLabel: boolean;
  actions: NodeActions;
};

const GraphNodeView = memo(function GraphNodeView({
  node,
  title,
  near,
  lit,
  selected,
  pinned,
  showLabel,
  actions,
}: GraphNodeViewProps) {
  const radius = nodeRadius(node);
  const Icon = nodeIcon(node);
  const colour = nodeColour(node);
  const isBook = node.nodeType === "lorebook";
  const isCard = node.nodeType === "character";
  const isPersona = node.nodeType === "persona";
  const inferred = node.nodeType === "lore" ? node.inferredFamily : null;
  const secondaryColour =
    node.nodeType === "lore" && node.secondaryFamilies.length > 0 ? familyColour(node.secondaryFamilies[0]!) : null;
  const disabled = (node.nodeType === "lore" || node.nodeType === "lorebook") && !node.enabled;
  const fill = inferred ? `url(#lm-hatch-${inferred})` : `color-mix(in srgb, ${colour} 22%, var(--lm-graph-surface))`;

  return (
    <g
      ref={(element) => actions.register(node.ref, element)}
      role="button"
      tabIndex={0}
      aria-label={`${node.name} (${node.nodeType === "lore" ? node.family : node.nodeType})`}
      opacity={disabled ? 0.5 : 1}
      style={{ cursor: "grab", outline: "none" }}
      data-lm-graph-node={node.ref}
      data-lm-graph-near={near || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") actions.hover(node.ref);
      }}
      onPointerLeave={() => actions.hover(null, node.ref)}
      onPointerDown={(event) => actions.pointerDownNode(node.ref, event)}
      onDoubleClick={() => actions.doubleClick(node)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.open(node.ref);
        }
      }}
    >
      {selected ? (
        isBook ? (
          <rect
            x={-(radius + 4)}
            y={-(radius + 4)}
            width={(radius + 4) * 2}
            height={(radius + 4) * 2}
            rx={8}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle
            r={radius + 4}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
          />
        )
      ) : null}

      {secondaryColour ? (
        <circle
          r={radius + 2}
          fill="none"
          stroke={secondaryColour}
          strokeWidth={1.6}
          strokeDasharray="4 2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}

      {isBook ? (
        <rect
          x={-radius}
          y={-radius}
          width={radius * 2}
          height={radius * 2}
          rx={6}
          fill={fill}
          stroke={colour}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ) : isCard ? (
        <polygon
          points={hexPoints(radius + 1)}
          fill={fill}
          stroke={colour}
          strokeWidth={2.2}
          vectorEffect="non-scaling-stroke"
        />
      ) : isPersona ? (
        <rect
          x={-radius * 0.85}
          y={-radius * 0.85}
          width={radius * 1.7}
          height={radius * 1.7}
          rx={3}
          transform="rotate(45)"
          fill={fill}
          stroke={colour}
          strokeWidth={2.2}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <circle
          r={radius}
          fill={fill}
          stroke={colour}
          strokeWidth={2}
          strokeDasharray={inferred ? "3 2" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {pinned ? (
        <circle
          cx={radius * 0.72}
          cy={-radius * 0.72}
          r={2.8}
          fill="var(--primary)"
          stroke="var(--lm-graph-canvas)"
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}

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
          fontWeight={lit || selected || isBook ? 650 : undefined}
          fill="var(--foreground)"
          stroke="var(--lm-graph-canvas)"
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
          pointerEvents="none"
          data-lm-graph-label
        >
          {isBook ? `${title} (${node.entryCount})` : title}
        </text>
      ) : null}
    </g>
  );
});

export interface LorebookGraphProps {
  payload: LmGraphPayload;
  selectedLorebookIds: ReadonlySet<string>;
  collapsedLorebookIds: ReadonlySet<string>;
  onToggleCollapseLorebook: (lorebookId: string) => void;
  onOpenLorebook?: (lorebookId: string) => void;
  search: string;
  selectedNodeRef: string | null;
  onSelectNodeRef: (ref: string | null) => void;
  savingRef: string | null;
  onSaveRelationships: (entry: LmEntryNode, nextRelationships: Record<string, string>) => Promise<void>;
  onBatchSaveRelationships: (
    updates: Array<{ entry: LmEntryNode; relationships: Record<string, string> }>,
  ) => Promise<void>;
  onUpdateEntry: (entry: LmEntryNode, patch: LmEntryPatch) => Promise<void>;
}

export function LorebookGraph({
  payload,
  selectedLorebookIds,
  collapsedLorebookIds,
  onToggleCollapseLorebook,
  onOpenLorebook,
  search,
  selectedNodeRef,
  onSelectNodeRef,
  savingRef,
  onSaveRelationships,
  onBatchSaveRelationships,
  onUpdateEntry,
}: LorebookGraphProps) {
  const [whole, setWhole] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [floating, setFloating] = useState(false);
  const [hiddenFamilies, setHiddenFamilies] = useState<ReadonlySet<EntityFamily>>(() => new Set());
  const [showCharacters, setShowCharacters] = useState(true);
  const [showPersonas, setShowPersonas] = useState(true);
  const [showExplicit, setShowExplicit] = useState(true);
  const [showMentions, setShowMentions] = useState(true);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [layoutSpread, setLayoutSpread] = useState(1);
  const [pinnedPositions, setPinnedPositions] = useState<Record<string, GraphPoint>>({});
  const [focusPick, setFocusPick] = useState<string | null>(null);
  const [hoverRef, setHoverRef] = useState<string | null>(null);
  const [view, setView] = useState<GraphView>({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [navHistory, setNavHistory] = useState<string[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const [readerState, setReaderState] = useState<{ ref: string; mode: "read" | "edit" } | null>(null);

  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const pointers = useRef(new Map<number, GraphPoint>());
  const press = useRef({ start: { x: 0, y: 0 }, moved: false });
  const layoutCacheRef = useRef<{ key: string; positions: Map<string, GraphPoint> } | null>(null);
  const hasFittedRef = useRef(false);
  const lastFitTriggerRef = useRef("");
  const dragNode = useRef<{
    ref: string;
    pointerId: number;
    startScreen: GraphPoint;
    startGraph: GraphPoint;
    moved: boolean;
  } | null>(null);

  const navigateTo = useCallback(
    (ref: string | null, mode: "push" | "history" = "push") => {
      if (!ref) {
        onSelectNodeRef(null);
        return;
      }
      if (mode === "push") {
        setNavHistory((prev) => {
          if (prev[navIndex] === ref) return prev;
          const next = [...prev.slice(0, navIndex + 1), ref];
          setNavIndex(next.length - 1);
          return next;
        });
      }
      onSelectNodeRef(ref);
    },
    [navIndex, onSelectNodeRef],
  );

  useEffect(() => {
    if (!selectedNodeRef) return;
    setNavHistory((prev) => {
      if (prev.length === 0) {
        setNavIndex(0);
        return [selectedNodeRef];
      }
      if (prev[navIndex] === selectedNodeRef) return prev;
      return prev;
    });
  }, [selectedNodeRef, navIndex]);

  useEffect(() => {
    if (!readerState && !expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (readerState) {
        event.preventDefault();
        setReaderState(null);
      } else if (expanded) {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readerState, expanded]);

  const graph = useMemo(
    () =>
      buildLorebookGraph(payload, {
        lorebookIds: selectedLorebookIds,
        collapsedLorebookIds,
        hiddenFamilies,
        showCharacters,
        showPersonas,
        showExplicit,
        showMentions,
        hideOrphans,
        search,
      }),
    [
      payload,
      selectedLorebookIds,
      collapsedLorebookIds,
      hiddenFamilies,
      showCharacters,
      showPersonas,
      showExplicit,
      showMentions,
      hideOrphans,
      search,
    ],
  );

  const nodesByRef = useMemo(() => new Map(graph.nodes.map((node) => [node.ref, node])), [graph.nodes]);
  const allNodesByRef = useMemo(() => {
    const map = new Map<string, LmGraphNode>(payload.nodes.map((node) => [node.ref, node]));
    for (const node of graph.nodes) {
      if (node.nodeType === "lorebook" && !map.has(node.ref)) map.set(node.ref, node);
    }
    return map;
  }, [payload.nodes, graph.nodes]);

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

  const sortedNodeRefsKey = useMemo(
    () =>
      shown.nodes
        .map((node) => node.ref)
        .sort()
        .join("|"),
    [shown.nodes],
  );

  const topologyKey = useMemo(() => {
    const edgePairs = new Set<string>();
    for (const edge of shown.edges) {
      edgePairs.add(
        edge.sourceRef < edge.targetRef ? `${edge.sourceRef}~${edge.targetRef}` : `${edge.targetRef}~${edge.sourceRef}`,
      );
    }
    return `${sortedNodeRefsKey}::${[...edgePairs].sort().join("|")}::${layoutSpread}`;
  }, [sortedNodeRefsKey, shown.edges, layoutSpread]);

  const computedPositions = useMemo(() => {
    if (layoutCacheRef.current?.key === topologyKey) {
      return layoutCacheRef.current.positions;
    }
    const positions = layoutGraph(shown, 1, LAYOUT_MAX_ITERATIONS, layoutSpread).positions;
    layoutCacheRef.current = { key: topologyKey, positions };
    return positions;
  }, [topologyKey, shown, layoutSpread]);

  const effectivePositions = useMemo(() => {
    const merged = new Map(computedPositions);
    for (const [ref, point] of Object.entries(pinnedPositions)) {
      if (merged.has(ref)) merged.set(ref, point);
    }
    return merged;
  }, [computedPositions, pinnedPositions]);

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
    const points = [...effectivePositions.values()];
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
  }, [effectivePositions, size.w, size.h]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitTrigger = `${sortedNodeRefsKey}::${layoutSpread}`;
  useEffect(() => {
    if (effectivePositions.size === 0 || size.w <= 0 || size.h <= 0) return;
    if (!hasFittedRef.current || lastFitTriggerRef.current !== fitTrigger) {
      hasFittedRef.current = true;
      lastFitTriggerRef.current = fitTrigger;
      fitRef.current();
    }
  }, [fitTrigger, effectivePositions.size, size.w, size.h]);

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
      effectivePositions,
      (ref) => {
        const node = nodesByRef.get(ref);
        return node ? nodeRadius(node) * nodeScale(view.k) : 0;
      },
      view,
      screenPoint(event),
      TAP_TARGET,
    );

  const effectivePositionsRef = useRef(effectivePositions);
  effectivePositionsRef.current = effectivePositions;

  const nodeActions = useMemo<NodeActions>(
    () => ({
      register: (ref, element) => {
        if (element) nodeRefs.current.set(ref, element);
        else nodeRefs.current.delete(ref);
      },
      hover: (ref, from) => setHoverRef((current) => (ref === null && current !== from ? current : ref)),
      open: (ref) => navigateTo(ref),
      doubleClick: (node) => {
        if (node.nodeType === "lorebook") {
          onToggleCollapseLorebook(node.id);
          return;
        }
        setFocusPick(node.ref);
        setWhole(false);
      },
      pointerDownNode: (ref, event) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        event.stopPropagation();
        const startGraph = effectivePositionsRef.current.get(ref);
        if (!startGraph) return;
        svgRef.current?.setPointerCapture(event.pointerId);
        dragNode.current = {
          ref,
          pointerId: event.pointerId,
          startScreen: screenPoint(event),
          startGraph,
          moved: false,
        };
      },
    }),
    [navigateTo, onToggleCollapseLorebook],
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
      if (node.nodeType === "lorebook") continue;
      if (node.nodeType === "lore" && filterByBooks && !selectedLorebookIds.has(node.lorebookId)) continue;
      if (node.nodeType === "character" && !showCharacters) continue;
      if (node.nodeType === "persona" && !showPersonas) continue;
      const families = node.nodeType === "lore" ? [node.family, ...node.secondaryFamilies] : [node.family];
      for (const family of families) {
        familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      }
    }
    return familyCounts;
  }, [payload.nodes, selectedLorebookIds, showCharacters, showPersonas]);

  const edgeScale = nodeScale(view.k);
  const labelEveryNode = shown.nodes.length <= LABEL_ALL_LIMIT || view.k >= LABEL_ZOOM;

  const edgeLayer = useMemo(
    () =>
      shown.edges.map((edge, index) => {
        const from = effectivePositions.get(edge.sourceRef);
        const to = effectivePositions.get(edge.targetRef);
        const fromNode = nodesByRef.get(edge.sourceRef);
        const toNode = nodesByRef.get(edge.targetRef);
        if (!from || !to || !fromNode || !toNode) return null;
        const lit = activeId !== null && (edge.sourceRef === activeId || edge.targetRef === activeId);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        const gapFrom = (nodeRadius(fromNode) + 2) * edgeScale;
        const gapTo = (nodeRadius(toNode) + 2) * edgeScale;
        const hasRoom = length > gapFrom + gapTo;
        const dimmed = hoverRef && !(edge.sourceRef === hoverRef || edge.targetRef === hoverRef);

        if (edge.kind === "book_link") {
          return (
            <line
              key={`book|${edge.sourceRef}|${edge.targetRef}|${index}`}
              x1={from.x + (dx / length) * gapFrom}
              y1={from.y + (dy / length) * gapFrom}
              x2={to.x - (dx / length) * gapTo}
              y2={to.y - (dy / length) * gapTo}
              stroke={lit ? "var(--lm-graph-ink)" : "var(--lm-graph-book-link)"}
              strokeWidth={lit ? 1.8 : 1.2}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
              opacity={dimmed ? 0.12 : 0.85}
            >
              <title>{`${fromNode.name} — linked lorebook — ${toNode.name}`}</title>
            </line>
          );
        }

        const isExplicit = edge.kind === "explicit";
        const isMutual = edge.bidirectional === true;
        const relArrow = isExplicit && lit ? relationMarkerId(edge.relation) : null;
        const arrowId = isExplicit
          ? (relArrow ?? (lit ? ARROW_EXPLICIT_LIT_ID : ARROW_EXPLICIT_ID))
          : lit
            ? ARROW_MENTION_LIT_ID
            : ARROW_MENTION_ID;
        const stroke = lit
          ? isExplicit
            ? relationStroke(edge.relation)
            : "var(--lm-graph-ink)"
          : isExplicit
            ? "var(--lm-graph-edge)"
            : isMutual
              ? "var(--lm-graph-mention-mutual)"
              : "var(--lm-graph-mention)";
        const strokeWidth = isExplicit
          ? isMutual
            ? lit
              ? 3
              : 2.2
            : lit
              ? 2.2
              : 1.5
          : isMutual
            ? lit
              ? 2.2
              : 1.5
            : lit
              ? 1.5
              : 1.1;
        const strokeDasharray = isExplicit ? undefined : isMutual ? "8 3" : "5 4";
        const tooltip = isMutual
          ? `${fromNode.name} ↔ ${toNode.name} (${edge.relation}${edge.matchedText ? `: "${edge.matchedText}" / "${edge.reverseMatchedText ?? edge.matchedText}"` : ""})`
          : `${fromNode.name} → ${toNode.name} (${edge.relation}${edge.matchedText ? `: "${edge.matchedText}"` : ""})`;

        return (
          <line
            key={`${edge.kind}|${edge.sourceRef}|${edge.targetRef}|${edge.relation}|${index}`}
            x1={from.x + (dx / length) * gapFrom}
            y1={from.y + (dy / length) * gapFrom}
            x2={to.x - (dx / length) * gapTo}
            y2={to.y - (dy / length) * gapTo}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            vectorEffect="non-scaling-stroke"
            opacity={dimmed ? 0.12 : 1}
            markerStart={hasRoom && isMutual ? `url(#${arrowId})` : undefined}
            markerEnd={hasRoom ? `url(#${arrowId})` : undefined}
          >
            <title>{tooltip}</title>
          </line>
        );
      }),
    [shown.edges, effectivePositions, nodesByRef, activeId, hoverRef, edgeScale],
  );

  const nodeLayer = useMemo(
    () =>
      shown.nodes.map((node) => {
        if (!effectivePositions.has(node.ref)) return null;
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
            pinned={node.ref in pinnedPositions}
            showLabel={labelEveryNode || node.ref === focusRef || selected || lit || node.nodeType !== "lore"}
            actions={nodeActions}
          />
        );
      }),
    [
      shown.nodes,
      effectivePositions,
      pinnedPositions,
      activeNear,
      pointNear,
      selectedNodeRef,
      focusRef,
      labelEveryNode,
      nodeActions,
    ],
  );

  const labelScale = 1 / nodeScreenScale(view.k);
  useLayoutEffect(() => {
    const write = (element: Element, value: string) => {
      if (element.getAttribute("transform") !== value) element.setAttribute("transform", value);
    };
    for (const [ref, element] of nodeRefs.current) {
      const point = effectivePositions.get(ref);
      const node = nodesByRef.get(ref);
      if (!point || !node) continue;
      write(element, `translate(${point.x} ${point.y}) scale(${edgeScale})`);
      const label = element.querySelector("[data-lm-graph-label]");
      if (label) write(label, `translate(0 ${nodeRadius(node)}) scale(${labelScale})`);
    }
  }, [nodeLayer, effectivePositions, nodesByRef, edgeScale, labelScale]);

  const toggleFamily = (family: EntityFamily) =>
    setHiddenFamilies((current) => {
      const next = new Set(current);
      if (!next.delete(family)) next.add(family);
      return next;
    });

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex >= 0 && navIndex < navHistory.length - 1;
  const focusNodeName = focusRef ? allNodesByRef.get(focusRef)?.name : null;
  const pinnedCount = Object.keys(pinnedPositions).length;
  const readerNode = readerState ? (allNodesByRef.get(readerState.ref) ?? null) : null;

  const inspectorCard = activeNode ? (
    <GraphInspector
      activeNode={activeNode}
      nodeColour={nodeColour(activeNode)}
      familyLabel={FAMILY_META[activeNode.family].label}
      payload={payload}
      allNodesByRef={allNodesByRef}
      canvasWrap={wrap}
      floating={floating}
      onToggleFloating={() => setFloating((value) => !value)}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onGoBack={() => {
        if (!canGoBack) return;
        const prevIndex = navIndex - 1;
        setNavIndex(prevIndex);
        navigateTo(navHistory[prevIndex] ?? null, "history");
      }}
      onGoForward={() => {
        if (!canGoForward) return;
        const nextIdx = navIndex + 1;
        setNavIndex(nextIdx);
        navigateTo(navHistory[nextIdx] ?? null, "history");
      }}
      onFocusHere={(ref) => {
        setFocusPick(ref);
        setWhole(false);
      }}
      onNavigate={(ref) => navigateTo(ref)}
      onOpenReader={(node, mode) => setReaderState({ ref: node.ref, mode })}
      onOpenLorebook={onOpenLorebook}
      onToggleCollapseLorebook={onToggleCollapseLorebook}
      savingRef={savingRef}
      onSaveRelationships={onSaveRelationships}
      onBatchSaveRelationships={onBatchSaveRelationships}
      onUpdateEntry={onUpdateEntry}
    />
  ) : null;

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
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-sm"
            style={{ background: "var(--lm-graph-card)" }}
          />
          Cards
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={showPersonas}
          onClick={() => setShowPersonas((value) => !value)}
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rotate-45 rounded-[2px]"
            style={{ background: "var(--lm-graph-persona)" }}
          />
          Personas
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small whitespace-nowrap"
          aria-pressed={hideOrphans}
          onClick={() => setHideOrphans((value) => !value)}
        >
          <EyeOff aria-hidden="true" size="0.875rem" />
          Hide unlinked
        </button>

        <span aria-hidden="true" data-lm-graph-divider />

        <label className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-foreground)]">
          <span>Spacing</span>
          <input
            type="range"
            aria-label="Node spacing"
            min={0.5}
            max={2.4}
            step={0.1}
            value={layoutSpread}
            onChange={(event) => setLayoutSpread(Number(event.target.value))}
            className="h-1.5 w-20 accent-[var(--primary)]"
          />
        </label>
      </div>

      {shown.nodes.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
          No nodes match the current lorebook or filter selection.
        </div>
      ) : (
        <div data-lm-graph-workspace className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start">
          <div
            ref={setWrap}
            className="relative min-w-0 flex-1 overflow-hidden select-none"
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
              {pinnedCount > 0 ? (
                <button
                  type="button"
                  className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
                  title="Reset dragged node positions"
                  aria-label="Reset dragged node positions"
                  onClick={() => setPinnedPositions({})}
                >
                  <RotateCcw size="0.875rem" />
                </button>
              ) : null}
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
                if (dragNode.current && dragNode.current.pointerId === event.pointerId) {
                  const next = screenPoint(event);
                  const dxScreen = next.x - dragNode.current.startScreen.x;
                  const dyScreen = next.y - dragNode.current.startScreen.y;
                  if (!dragNode.current.moved && Math.hypot(dxScreen, dyScreen) > TAP_SLOP) {
                    dragNode.current.moved = true;
                  }
                  if (dragNode.current.moved) {
                    const ref = dragNode.current.ref;
                    const pos = {
                      x: dragNode.current.startGraph.x + dxScreen / view.k,
                      y: dragNode.current.startGraph.y + dyScreen / view.k,
                    };
                    setPinnedPositions((prev) => ({ ...prev, [ref]: pos }));
                  }
                  return;
                }

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
                if (dragNode.current && dragNode.current.pointerId === event.pointerId) {
                  const finished = dragNode.current;
                  dragNode.current = null;
                  if (!finished.moved) navigateTo(finished.ref);
                  return;
                }
                const wasSingle = pointers.current.size === 1;
                pointers.current.delete(event.pointerId);
                if (wasSingle && !press.current.moved) {
                  const target = event.target as Element | null;
                  if (!target?.closest("[data-lm-graph-node]")) {
                    const hit = nodeAt(event);
                    if (hit) navigateTo(hit);
                    else navigateTo(null);
                  }
                }
              }}
              onPointerCancel={(event) => {
                if (dragNode.current?.pointerId === event.pointerId) dragNode.current = null;
                pointers.current.delete(event.pointerId);
              }}
            >
              <defs>
                <pattern
                  id="lm-hatch-character"
                  patternUnits="userSpaceOnUse"
                  width="6"
                  height="6"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill="var(--lm-graph-surface)" />
                  <line
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="6"
                    stroke="var(--lm-graph-character)"
                    strokeOpacity="0.45"
                    strokeWidth="2.5"
                  />
                </pattern>
                <pattern
                  id="lm-hatch-item"
                  patternUnits="userSpaceOnUse"
                  width="6"
                  height="6"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill="var(--lm-graph-surface)" />
                  <line
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="6"
                    stroke="var(--lm-graph-item)"
                    strokeOpacity="0.45"
                    strokeWidth="2.5"
                  />
                </pattern>
                <pattern
                  id="lm-hatch-ability"
                  patternUnits="userSpaceOnUse"
                  width="6"
                  height="6"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill="var(--lm-graph-surface)" />
                  <line
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="6"
                    stroke="var(--lm-graph-ability)"
                    strokeOpacity="0.45"
                    strokeWidth="2.5"
                  />
                </pattern>
                <marker
                  id={ARROW_EXPLICIT_ID}
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="7.5"
                  markerHeight="7.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 L 2.2 5 z" fill="var(--lm-graph-edge)" />
                </marker>
                <marker
                  id={ARROW_EXPLICIT_LIT_ID}
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="8.5"
                  markerHeight="8.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 L 2.2 5 z" fill="var(--lm-graph-ink)" />
                </marker>
                {Object.entries(RELATION_COLORS).map(([rel, color]) => (
                  <marker
                    key={rel}
                    id={`lm-graph-arrow-rel-${rel}`}
                    viewBox="0 0 10 10"
                    refX="8.5"
                    refY="5"
                    markerWidth="8.5"
                    markerHeight="8.5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 L 2.2 5 z" fill={color} />
                  </marker>
                ))}
                <marker
                  id={ARROW_MENTION_ID}
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="6.5"
                  markerHeight="6.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.2 L 9 5 L 0 8.8 L 2 5 z" fill="var(--lm-graph-mention)" />
                </marker>
                <marker
                  id={ARROW_MENTION_LIT_ID}
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="7.5"
                  markerHeight="7.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.2 L 9 5 L 0 8.8 L 2 5 z" fill="var(--lm-graph-ink)" />
                </marker>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                <g>{edgeLayer}</g>
                <g>{nodeLayer}</g>
              </g>
            </svg>

            {floating ? inspectorCard : null}
          </div>

          {!floating ? inspectorCard : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--muted-foreground)]">
        <span>
          {shown.nodes.length} nodes · {shown.edges.filter((e) => e.kind === "explicit").length} ID links ·{" "}
          {shown.edges.filter((e) => e.kind === "mention").length} mentions
        </span>
        <span>
          Solid = ID link · Dashed = mention · Hatched = book-category hint · Drag nodes to pin · Double-click to
          focus/expand
        </span>
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

  return expanded && typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
