import type { EntityFamily, LmBuiltGraph, LmGraphEdge, LmGraphFilters, LmGraphNode, LmGraphPayload } from "./schema.js";

const CHARACTER_TAGS = new Set(["character", "char", "npc", "person", "companion", "cast"]);
const LOCATION_TAGS = new Set([
  "location",
  "place",
  "region",
  "city",
  "town",
  "village",
  "room",
  "building",
  "area",
  "map",
]);
const FACTION_TAGS = new Set(["faction", "guild", "org", "organization", "clan", "order", "company", "group"]);
const ITEM_TAGS = new Set(["item", "artifact", "weapon", "armor", "gear", "equipment", "spell", "relic"]);
const QUEST_TAGS = new Set(["quest", "plot", "event", "arc", "hook", "thread", "scene"]);

/** Map a lorebook entry's tag (with category fallback) to a graph colour family. */
export function classifyEntryFamily(tag: string | undefined, lorebookCategory: string | undefined): EntityFamily {
  const normalizedTag = tag?.trim().toLowerCase() ?? "";
  if (normalizedTag) {
    if (CHARACTER_TAGS.has(normalizedTag)) return "character";
    if (LOCATION_TAGS.has(normalizedTag)) return "location";
    if (FACTION_TAGS.has(normalizedTag)) return "faction";
    if (ITEM_TAGS.has(normalizedTag)) return "item";
    if (QUEST_TAGS.has(normalizedTag)) return "quest";
  }
  const normalizedCategory = lorebookCategory?.trim().toLowerCase() ?? "";
  if (normalizedCategory === "character" || normalizedCategory === "npc") return "character";
  if (normalizedCategory === "spellbook") return "item";
  return "lore";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRegexLiteral(token: string): boolean {
  return token.length >= 3 && token.startsWith("/") && /\/[gimsuy]*$/u.test(token);
}

interface SearchTerm {
  term: string;
  regex: RegExp;
}

function compileSearchTerms(node: LmGraphNode): SearchTerm[] {
  const rawTerms = node.nodeType === "lore" ? [node.name, ...node.keys] : [node.name, ...node.aliases];
  const seen = new Set<string>();
  const compiled: SearchTerm[] = [];
  for (const raw of rawTerms) {
    const term = raw.trim();
    if (term.length < 3 || isRegexLiteral(term)) continue;
    const lowered = term.toLocaleLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    const escaped = escapeRegExp(term);
    // Word boundary when edge characters are word chars; avoids splitting mid-word.
    const prefix = /^\w/u.test(term) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = /\w$/u.test(term) ? "(?![\\p{L}\\p{N}_])" : "";
    compiled.push({ term, regex: new RegExp(`${prefix}${escaped}${suffix}`, "iu") });
  }
  return compiled;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Scan lore entry content + description for whole-word mentions of other nodes'
 * names, keys, or character aliases. Pairs that already have an explicit ID link
 * in either direction are skipped so promoting a mention turns dashed -> solid
 * cleanly without duplicate lines.
 */
export function extractMentionEdges(
  nodes: readonly LmGraphNode[],
  explicitEdges: readonly LmGraphEdge[],
): LmGraphEdge[] {
  const explicitPairs = new Set(explicitEdges.map((edge) => pairKey(edge.sourceRef, edge.targetRef)));
  const targets = nodes
    .map((node) => ({ node, terms: compileSearchTerms(node) }))
    .filter((item) => item.terms.length > 0);
  const mentions: LmGraphEdge[] = [];
  const emitted = new Set<string>();

  for (const source of nodes) {
    if (source.nodeType !== "lore") continue;
    const haystack = `${source.description}\n${source.content}`.trim();
    if (!haystack) continue;
    for (const target of targets) {
      if (target.node.ref === source.ref) continue;
      if (explicitPairs.has(pairKey(source.ref, target.node.ref))) continue;
      const dedupeKey = `${source.ref}\u0000${target.node.ref}`;
      if (emitted.has(dedupeKey)) continue;
      const hit = target.terms.find((candidate) => candidate.regex.test(haystack));
      if (!hit) continue;
      emitted.add(dedupeKey);
      mentions.push({
        kind: "mention",
        sourceRef: source.ref,
        targetRef: target.node.ref,
        relation: "mentions",
        matchedText: hit.term,
      });
    }
  }
  return mentions;
}

function matchesSearch(node: LmGraphNode, query: string): boolean {
  if (!query) return true;
  if (node.name.toLocaleLowerCase().includes(query)) return true;
  if (node.description.toLocaleLowerCase().includes(query)) return true;
  if (node.nodeType === "lore") {
    if (node.tag.toLocaleLowerCase().includes(query)) return true;
    if (node.lorebookName.toLocaleLowerCase().includes(query)) return true;
    if (node.keys.some((key) => key.toLocaleLowerCase().includes(query))) return true;
    return node.content.toLocaleLowerCase().includes(query);
  }
  return node.aliases.some((alias) => alias.toLocaleLowerCase().includes(query));
}

/** Filter nodes and edges for the current workbench view and compute node degrees. */
export function buildLorebookGraph(payload: LmGraphPayload, filters: LmGraphFilters = {}): LmBuiltGraph {
  const lorebookIds = filters.lorebookIds;
  const filterByBooks = Boolean(lorebookIds && lorebookIds.size > 0);
  const showCharacters = filters.showCharacters ?? true;
  const showPersonas = filters.showPersonas ?? true;
  const showExplicit = filters.showExplicit ?? true;
  const showMentions = filters.showMentions ?? true;
  const query = filters.search?.trim().toLocaleLowerCase() ?? "";

  const kept = new Map<string, LmGraphNode & { degree: number }>();
  for (const node of payload.nodes) {
    if (node.nodeType === "lore") {
      if (filterByBooks && !lorebookIds!.has(node.lorebookId)) continue;
    } else if (node.nodeType === "character") {
      if (!showCharacters) continue;
    } else if (node.nodeType === "persona") {
      if (!showPersonas) continue;
    }
    if (filters.hiddenFamilies?.has(node.family)) continue;
    if (!matchesSearch(node, query)) continue;
    kept.set(node.ref, { ...node, degree: 0 });
  }

  const edges: LmGraphEdge[] = [];
  const candidateEdges = [
    ...(showExplicit ? payload.explicitEdges : []),
    ...(showMentions ? payload.mentionEdges : []),
  ];
  for (const edge of candidateEdges) {
    if (edge.sourceRef === edge.targetRef) continue;
    if (!kept.has(edge.sourceRef) || !kept.has(edge.targetRef)) continue;
    edges.push(edge);
    kept.get(edge.sourceRef)!.degree += 1;
    kept.get(edge.targetRef)!.degree += 1;
  }

  return { nodes: [...kept.values()], edges };
}

/** Undirected BFS up to `hops` links for Focus mode. */
export function neighbourhood(graph: LmBuiltGraph, ref: string, hops: number): Set<string> {
  const known = new Set(graph.nodes.map((node) => node.ref));
  if (!known.has(ref)) return new Set();
  const adjacent = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = adjacent.get(from) ?? [];
    list.push(to);
    adjacent.set(from, list);
  };
  for (const edge of graph.edges) {
    add(edge.sourceRef, edge.targetRef);
    add(edge.targetRef, edge.sourceRef);
  }
  const reached = new Set([ref]);
  let frontier = [ref];
  for (let depth = 0; depth < hops && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const other of adjacent.get(current) ?? []) {
        if (reached.has(other)) continue;
        reached.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return reached;
}

/** Pick the Focus anchor: explicit selection if visible, else highest-degree node, else first node. */
export function defaultFocus(graph: LmBuiltGraph, selectedRef: string | null | undefined): string | null {
  if (selectedRef && graph.nodes.some((node) => node.ref === selectedRef)) return selectedRef;
  let best: (LmGraphNode & { degree: number }) | null = null;
  for (const node of graph.nodes) {
    if (!best || node.degree > best.degree || (node.degree === best.degree && node.ref < best.ref)) {
      best = node;
    }
  }
  return best?.ref ?? null;
}

export type GraphPoint = { x: number; y: number };
export type GraphView = { k: number; x: number; y: number };

export function pinchView(
  view: GraphView,
  before: readonly [GraphPoint, GraphPoint],
  after: readonly [GraphPoint, GraphPoint],
  minZoom: number,
  maxZoom: number,
): GraphView {
  const spread = (pair: readonly [GraphPoint, GraphPoint]) =>
    Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) || 1;
  const middle = (pair: readonly [GraphPoint, GraphPoint]) => ({
    x: (pair[0].x + pair[1].x) / 2,
    y: (pair[0].y + pair[1].y) / 2,
  });
  const k = Math.min(maxZoom, Math.max(minZoom, view.k * (spread(after) / spread(before))));
  const from = middle(before);
  const to = middle(after);
  return { k, x: to.x - ((from.x - view.x) / view.k) * k, y: to.y - ((from.y - view.y) / view.k) * k };
}

export function nodeAtPoint(
  positions: ReadonlyMap<string, GraphPoint>,
  radiusOf: (ref: string) => number,
  view: GraphView,
  point: GraphPoint,
  minHit: number,
): string | null {
  let found: string | null = null;
  let nearest = Infinity;
  for (const [ref, position] of positions) {
    const distance = Math.hypot(position.x * view.k + view.x - point.x, position.y * view.k + view.y - point.y);
    if (distance <= Math.max(radiusOf(ref) * view.k, minHit / 2) && distance < nearest) {
      nearest = distance;
      found = ref;
    }
  }
  return found;
}

export const LAYOUT_SIZE = 1000;
export const LAYOUT_MAX_ITERATIONS = 300;

export type LayoutResult = { positions: Map<string, GraphPoint>; iterations: number };

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded Fruchterman-Reingold force-directed layout.
 * ponytail: O(n^2) repulsion per step on the main thread, comfortable up to ~500 visible nodes.
 * Move into a Web Worker or replace with a quadtree layout if lorebooks grow past that ceiling.
 */
export function layoutGraph(graph: LmBuiltGraph, seed = 1, iterations = LAYOUT_MAX_ITERATIONS): LayoutResult {
  const steps = Math.max(0, Math.min(Math.floor(iterations), LAYOUT_MAX_ITERATIONS));
  const refs = graph.nodes.map((node) => node.ref).sort();
  const count = refs.length;
  const random = seededRandom(seed);
  const index = new Map(refs.map((ref, position) => [ref, position]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const radius = LAYOUT_SIZE * 0.35;
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / Math.max(count, 1);
    xs[i] = LAYOUT_SIZE / 2 + radius * Math.cos(angle) + (random() - 0.5) * 20;
    ys[i] = LAYOUT_SIZE / 2 + radius * Math.sin(angle) + (random() - 0.5) * 20;
  }

  const pairs: Array<readonly [number, number]> = [];
  for (const edge of graph.edges) {
    const a = index.get(edge.sourceRef);
    const b = index.get(edge.targetRef);
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }

  const ideal = count > 0 ? Math.sqrt((LAYOUT_SIZE * LAYOUT_SIZE) / count) * 0.8 : 1;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let step = 0; step < steps; step += 1) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let vx = xs[i]! - xs[j]!;
        let vy = ys[i]! - ys[j]!;
        let distance = Math.hypot(vx, vy);
        if (distance < 0.01) {
          vx = (random() - 0.5) * 0.1;
          vy = (random() - 0.5) * 0.1;
          distance = 0.01;
        }
        const push = (ideal * ideal) / distance;
        dx[i]! += (vx / distance) * push;
        dy[i]! += (vy / distance) * push;
        dx[j]! -= (vx / distance) * push;
        dy[j]! -= (vy / distance) * push;
      }
    }
    for (const [a, b] of pairs) {
      const vx = xs[a]! - xs[b]!;
      const vy = ys[a]! - ys[b]!;
      const distance = Math.max(Math.hypot(vx, vy), 0.01);
      const pull = (distance * distance) / ideal;
      dx[a]! -= (vx / distance) * pull;
      dy[a]! -= (vy / distance) * pull;
      dx[b]! += (vx / distance) * pull;
      dy[b]! += (vy / distance) * pull;
    }
    const temperature = (LAYOUT_SIZE / 10) * (1 - step / steps);
    for (let i = 0; i < count; i += 1) {
      dx[i]! += LAYOUT_SIZE / 2 - xs[i]!;
      dy[i]! += LAYOUT_SIZE / 2 - ys[i]!;
      const length = Math.max(Math.hypot(dx[i]!, dy[i]!), 0.01);
      const move = Math.min(length, temperature);
      xs[i] = xs[i]! + (dx[i]! / length) * move;
      ys[i] = ys[i]! + (dy[i]! / length) * move;
    }
  }

  const positions = new Map<string, GraphPoint>();
  refs.forEach((ref, position) => positions.set(ref, { x: xs[position]!, y: ys[position]! }));
  return { positions, iterations: steps };
}
