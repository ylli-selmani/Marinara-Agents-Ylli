import { formatEntityRef } from "./entity-ref.js";
import type {
  EntityFamily,
  LmBookNode,
  LmBuiltGraph,
  LmGraphEdge,
  LmGraphFilters,
  LmGraphNode,
  LmGraphPayload,
} from "./schema.js";

const CHARACTER_TAGS = new Set([
  "character",
  "characters",
  "char",
  "npc",
  "npcs",
  "person",
  "people",
  "companion",
  "companions",
  "cast",
]);
const LOCATION_TAGS = new Set([
  "location",
  "locations",
  "place",
  "places",
  "region",
  "regions",
  "city",
  "cities",
  "town",
  "towns",
  "village",
  "villages",
  "room",
  "rooms",
  "building",
  "buildings",
  "area",
  "areas",
  "map",
  "maps",
]);
const FACTION_TAGS = new Set([
  "faction",
  "factions",
  "guild",
  "guilds",
  "org",
  "orgs",
  "organization",
  "organizations",
  "clan",
  "clans",
  "order",
  "orders",
  "company",
  "companies",
  "group",
  "groups",
]);
const ITEM_TAGS = new Set([
  "item",
  "items",
  "artifact",
  "artifacts",
  "weapon",
  "weapons",
  "armor",
  "gear",
  "equipment",
  "relic",
  "relics",
]);
const CREATURE_TAGS = new Set([
  "creature",
  "creatures",
  "species",
  "race",
  "races",
  "monster",
  "monsters",
  "beast",
  "beasts",
  "demon",
  "demons",
  "spirit",
  "spirits",
  "animal",
  "animals",
]);
const ABILITY_TAGS = new Set([
  "ability",
  "abilities",
  "power",
  "powers",
  "quirk",
  "quirks",
  "spell",
  "spells",
  "skill",
  "skills",
  "magic",
  "technique",
  "techniques",
  "trait",
  "traits",
  "class",
  "classes",
]);
const LORE_TAGS = new Set([
  "lore",
  "world",
  "history",
  "concept",
  "concepts",
  "setting",
  "rule",
  "rules",
  "context",
  "general",
]);
const QUEST_TAGS = new Set([
  "quest",
  "quests",
  "plot",
  "plots",
  "event",
  "events",
  "arc",
  "arcs",
  "hook",
  "hooks",
  "thread",
  "threads",
  "scene",
  "scenes",
]);

function mapSingleTag(token: string): EntityFamily | null {
  if (CHARACTER_TAGS.has(token)) return "character";
  if (LOCATION_TAGS.has(token)) return "location";
  if (FACTION_TAGS.has(token)) return "faction";
  if (ITEM_TAGS.has(token)) return "item";
  if (CREATURE_TAGS.has(token)) return "creature";
  if (ABILITY_TAGS.has(token)) return "ability";
  if (QUEST_TAGS.has(token)) return "quest";
  if (LORE_TAGS.has(token)) return "lore";
  return null;
}

/**
 * Classify a lorebook entry from comma-separated explicit `tag` values.
 * Untagged entries inside `character`, `npc`, or `spellbook` lorebooks stay in
 * `"lore"` while returning `inferredFamily` for soft visuals; an explicit
 * `"lore"` tag clears that fallback.
 */
export function classifyEntryWithFallback(
  tag: string | undefined,
  lorebookCategory: string | undefined,
): { family: EntityFamily; secondaryFamilies: EntityFamily[]; inferredFamily: EntityFamily | null } {
  const matched: EntityFamily[] = [];
  if (tag) {
    for (const part of tag.split(",")) {
      const token = part.trim().toLowerCase();
      if (!token) continue;
      const mapped = mapSingleTag(token);
      if (mapped && !matched.includes(mapped)) matched.push(mapped);
    }
  }
  if (matched.length > 0) {
    return { family: matched[0]!, secondaryFamilies: matched.slice(1), inferredFamily: null };
  }
  const normalizedCategory = lorebookCategory?.trim().toLowerCase() ?? "";
  if (normalizedCategory === "character" || normalizedCategory === "npc") {
    return { family: "lore", secondaryFamilies: [], inferredFamily: "character" };
  }
  if (normalizedCategory === "spellbook") {
    return { family: "lore", secondaryFamilies: [], inferredFamily: "ability" };
  }
  return { family: "lore", secondaryFamilies: [], inferredFamily: null };
}

/** Map a lorebook entry's tag (with category fallback suppressed on family count) to a graph colour family. */
export function classifyEntryFamily(tag: string | undefined, lorebookCategory: string | undefined): EntityFamily {
  return classifyEntryWithFallback(tag, lorebookCategory).family;
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
  if (node.nodeType === "lorebook") return [];
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
    const prefix = /^[\p{L}\p{N}_]/u.test(term) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = /[\p{L}\p{N}_]$/u.test(term) ? "(?![\\p{L}\\p{N}_])" : "";
    compiled.push({ term, regex: new RegExp(`${prefix}${escaped}${suffix}`, "iu") });
  }
  return compiled;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Scan lore entry content + description (and optional full character/persona text)
 * for whole-word mentions of other nodes' names, keys, or aliases. Pairs that already
 * have an explicit ID link in either direction are skipped so promoting a mention turns
 * dashed -> solid cleanly without duplicate lines.
 */
export function extractMentionEdges(
  nodes: readonly LmGraphNode[],
  explicitEdges: readonly LmGraphEdge[],
  extraScanTextByRef?: ReadonlyMap<string, string>,
): LmGraphEdge[] {
  const explicitPairs = new Set(explicitEdges.map((edge) => pairKey(edge.sourceRef, edge.targetRef)));
  const targets = nodes
    .map((node) => ({ node, terms: compileSearchTerms(node) }))
    .filter((item) => item.terms.length > 0);
  const mentions: LmGraphEdge[] = [];
  const emitted = new Set<string>();

  for (const source of nodes) {
    if (source.nodeType === "lorebook") continue;
    const rawHaystack =
      source.nodeType === "lore"
        ? `${source.description}\n${source.content}`
        : (extraScanTextByRef?.get(source.ref) ?? source.description);
    const haystack = rawHaystack.trim();
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

/**
 * Collapse opposing `A -> B` and `B -> A` edges of the same kind (`explicit` or
 * `mention`) into a single undirected-visual edge marked `bidirectional: true`,
 * preserving both relation labels / matched terms for tooltips and inspection.
 */
export function collapseBidirectionalEdges(edges: readonly LmGraphEdge[]): LmGraphEdge[] {
  const result: LmGraphEdge[] = [];
  const pairedIndex = new Map<string, number>();

  for (const edge of edges) {
    if (edge.kind === "book_link") {
      result.push(edge);
      continue;
    }
    const key = `${edge.kind}\u0000${pairKey(edge.sourceRef, edge.targetRef)}`;
    const existingIndex = pairedIndex.get(key);
    if (existingIndex === undefined) {
      pairedIndex.set(key, result.length);
      result.push({ ...edge, bidirectional: edge.bidirectional ?? false });
      continue;
    }
    const existing = result[existingIndex]!;
    if (existing.sourceRef === edge.sourceRef && existing.targetRef === edge.targetRef) continue;
    const combinedRelation =
      existing.relation === edge.relation ? existing.relation : `${existing.relation} / ${edge.relation}`;
    result[existingIndex] = {
      ...existing,
      relation: combinedRelation,
      bidirectional: true,
      reverseMatchedText: edge.matchedText ?? existing.reverseMatchedText,
    };
  }

  return result;
}

function matchesSearch(node: LmGraphNode, query: string): boolean {
  if (!query) return true;
  if (node.name.toLocaleLowerCase().includes(query)) return true;
  if (node.description.toLocaleLowerCase().includes(query)) return true;
  if (node.nodeType === "lorebook") {
    return node.category.toLocaleLowerCase().includes(query);
  }
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
  const collapsedBooks = filters.collapsedLorebookIds ?? new Set<string>();
  const showCharacters = filters.showCharacters ?? true;
  const showPersonas = filters.showPersonas ?? true;
  const showExplicit = filters.showExplicit ?? true;
  const showMentions = filters.showMentions ?? true;
  const showBookHubs = filters.showBookHubs ?? false;
  const hideOrphans = filters.hideOrphans ?? false;
  const query = filters.search?.trim().toLocaleLowerCase() ?? "";

  const kept = new Map<string, LmGraphNode & { degree: number }>();
  const collapsedRedirect = new Map<string, string>();

  for (const node of payload.nodes) {
    if (node.nodeType === "lorebook") continue;
    if (node.nodeType === "lore") {
      if (filterByBooks && !lorebookIds!.has(node.lorebookId)) continue;
      if (collapsedBooks.has(node.lorebookId)) {
        collapsedRedirect.set(node.ref, formatEntityRef("book", node.lorebookId));
        continue;
      }
    } else if (node.nodeType === "character") {
      if (!showCharacters) continue;
    } else if (node.nodeType === "persona") {
      if (!showPersonas) continue;
    }
    if (node.nodeType === "lore") {
      const families = [node.family, ...node.secondaryFamilies];
      if (filters.hiddenFamilies && families.every((family) => filters.hiddenFamilies!.has(family))) continue;
    } else if (filters.hiddenFamilies?.has(node.family)) {
      continue;
    }
    if (!matchesSearch(node, query)) continue;
    kept.set(node.ref, { ...node, degree: 0 });
  }

  const bookLinkEdges: LmGraphEdge[] = [];
  for (const book of payload.lorebooks) {
    if (!book.loaded) continue;
    if (filterByBooks && !lorebookIds!.has(book.id)) continue;
    const isCollapsed = collapsedBooks.has(book.id);
    const linkedRefs: string[] = [];
    for (const cid of book.characterIds) {
      const ref = formatEntityRef("char", cid);
      if (kept.has(ref)) linkedRefs.push(ref);
    }
    for (const pid of book.personaIds) {
      const ref = formatEntityRef("persona", pid);
      if (kept.has(ref)) linkedRefs.push(ref);
    }
    if (!isCollapsed && !showBookHubs && linkedRefs.length === 0) continue;

    const bookRef = formatEntityRef("book", book.id);
    const bookNode: LmBookNode = {
      nodeType: "lorebook",
      ref: bookRef,
      id: book.id,
      name: book.name,
      description: book.description,
      category: book.category,
      enabled: book.enabled,
      entryCount: book.entryCount,
      collapsed: isCollapsed,
      family: "lore",
    };
    if (!isCollapsed && !matchesSearch(bookNode, query)) continue;
    if (isCollapsed && query && !matchesSearch(bookNode, query)) {
      const hasMatchingEntry = payload.nodes.some(
        (n) => n.nodeType === "lore" && n.lorebookId === book.id && matchesSearch(n, query),
      );
      if (!hasMatchingEntry) continue;
    }
    kept.set(bookRef, { ...bookNode, degree: 0 });

    for (const targetRef of linkedRefs) {
      bookLinkEdges.push({
        kind: "book_link",
        sourceRef: targetRef,
        targetRef: bookRef,
        relation: "linked_lorebook",
      });
    }
  }

  const remapRef = (ref: string) => collapsedRedirect.get(ref) ?? ref;
  const candidateEdges: LmGraphEdge[] = [];
  const seenDirected = new Set<string>();
  const rawCandidateEdges = [
    ...(showExplicit ? payload.explicitEdges : []),
    ...(showMentions ? payload.mentionEdges : []),
  ];

  for (const edge of rawCandidateEdges) {
    const sourceRef = remapRef(edge.sourceRef);
    const targetRef = remapRef(edge.targetRef);
    if (sourceRef === targetRef) continue;
    if (!kept.has(sourceRef) || !kept.has(targetRef)) continue;
    const directedKey = `${edge.kind}\u0000${sourceRef}\u0000${targetRef}`;
    if (seenDirected.has(directedKey)) continue;
    seenDirected.add(directedKey);
    candidateEdges.push(
      sourceRef === edge.sourceRef && targetRef === edge.targetRef ? edge : { ...edge, sourceRef, targetRef },
    );
  }

  const edges = [...collapseBidirectionalEdges(candidateEdges), ...bookLinkEdges];
  for (const edge of edges) {
    kept.get(edge.sourceRef)!.degree += 1;
    kept.get(edge.targetRef)!.degree += 1;
  }

  const nodes = hideOrphans
    ? [...kept.values()].filter((node) => node.degree > 0 || (node.nodeType === "lorebook" && node.collapsed))
    : [...kept.values()];

  return { nodes, edges };
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
const LAYOUT_PAIR_BUDGET = 15_000_000;
const LAYOUT_MIN_STEPS_LARGE = 25;

export function layoutGraph(
  graph: LmBuiltGraph,
  seed = 1,
  iterations = LAYOUT_MAX_ITERATIONS,
  spread = 1,
): LayoutResult {
  // Repulsion is O(n²) per step on the UI thread; cap the total pair work so a 1,000-node library lays out
  // in well under a second (fewer, coarser steps) instead of freezing the tab. ~220 nodes still get every step.
  const pairBudgetSteps = Math.max(
    LAYOUT_MIN_STEPS_LARGE,
    Math.floor(LAYOUT_PAIR_BUDGET / Math.max(1, graph.nodes.length ** 2)),
  );
  const steps = Math.max(0, Math.min(Math.floor(iterations), LAYOUT_MAX_ITERATIONS, pairBudgetSteps));
  const safeSpread = Number.isFinite(spread) ? Math.min(2.5, Math.max(0.5, spread)) : 1;
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

  const ideal = (count > 0 ? Math.sqrt((LAYOUT_SIZE * LAYOUT_SIZE) / count) * 0.8 : 1) * safeSpread;
  const gravity = 1 / Math.max(1, safeSpread * 0.85);
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
    const temperature = ((LAYOUT_SIZE * Math.max(1, safeSpread)) / 10) * (1 - step / steps);
    for (let i = 0; i < count; i += 1) {
      dx[i]! += (LAYOUT_SIZE / 2 - xs[i]!) * gravity;
      dy[i]! += (LAYOUT_SIZE / 2 - ys[i]!) * gravity;
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
