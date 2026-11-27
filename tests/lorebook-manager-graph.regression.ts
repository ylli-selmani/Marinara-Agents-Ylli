import assert from "node:assert/strict";
import {
  LM_RELATIONS,
  LM_RELATION_VALUES,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/relations.js";
import {
  formatEntityRef,
  parseEntityRef,
  SYMMETRIC_RELATIONS,
  toRelationshipKey,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  buildLorebookGraph,
  classifyEntryFamily,
  classifyEntryWithFallback,
  collapseBidirectionalEdges,
  defaultFocus,
  extractMentionEdges,
  layoutGraph,
  neighbourhood,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/graph-model.js";
import { collectLinkedCastForLorebooks } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/compendium-helpers.js";
import { simulateLorebookRetrieval } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/retrieval.js";
import {
  CompendiumStoreError,
  createCompendium,
  deleteCompendium,
  getChatCompendiumBinding,
  listCompendiums,
  setChatCompendiumBinding,
  updateCompendium,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import type {
  LorebookManagerDocumentRecord,
  LorebookManagerDocumentStore,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import type {
  LmEntryNode,
  LmGraphEdge,
  LmGraphNode,
  LmGraphPayload,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";

// ── EntityRef parsing and relationship keys ───────────────────────────────────
assert.deepEqual(parseEntityRef("entry-123"), { kind: "lore", id: "entry-123", ref: "lore:entry-123" });
assert.deepEqual(parseEntityRef("char:elara"), { kind: "char", id: "elara", ref: "char:elara" });
assert.deepEqual(parseEntityRef("book:b1"), { kind: "book", id: "b1", ref: "book:b1" });
assert.deepEqual(parseEntityRef("loc:imperial-city"), {
  kind: "loc",
  id: "imperial-city",
  ref: "loc:imperial-city",
});
assert.equal(parseEntityRef("   "), null);
assert.equal(formatEntityRef("persona", "p1"), "persona:p1");
assert.equal(formatEntityRef("book", "b1"), "book:b1");
assert.equal(toRelationshipKey("lore:entry-123"), "entry-123");
assert.equal(toRelationshipKey("char:elara"), "char:elara");

// ── Family classification, explicit lore, creatures, abilities, multi-tags ────
assert.equal(classifyEntryFamily("location", "world"), "location");
assert.equal(classifyEntryFamily("locations", "world"), "location");
assert.equal(classifyEntryFamily("Guild", "world"), "faction");
assert.equal(classifyEntryFamily("Factions", "world"), "faction");
assert.equal(classifyEntryFamily("characters", "world"), "character");
assert.equal(classifyEntryFamily("artifact", "world"), "item");
assert.equal(classifyEntryFamily("Items", "world"), "item");
assert.equal(classifyEntryFamily("creature", "world"), "creature");
assert.equal(classifyEntryFamily("races", "world"), "species");
assert.equal(classifyEntryFamily("subspecies", "world"), "species");
assert.equal(classifyEntryFamily("monsters", "world"), "creature");
assert.equal(classifyEntryFamily("quirk", "world"), "ability");
assert.equal(classifyEntryFamily("spell", "world"), "ability");
assert.equal(classifyEntryFamily("quests", "world"), "quest");
assert.equal(classifyEntryFamily("", "world"), "lore");

assert.deepEqual(classifyEntryWithFallback("", "character"), {
  family: "lore",
  secondaryFamilies: [],
  inferredFamily: "character",
});
assert.deepEqual(classifyEntryWithFallback("lore", "character"), {
  family: "lore",
  secondaryFamilies: [],
  inferredFamily: null,
});
assert.deepEqual(classifyEntryWithFallback("", "npc"), {
  family: "lore",
  secondaryFamilies: [],
  inferredFamily: "character",
});
assert.deepEqual(classifyEntryWithFallback("", "spellbook"), {
  family: "lore",
  secondaryFamilies: [],
  inferredFamily: "ability",
});
assert.deepEqual(classifyEntryWithFallback("location, faction", "character"), {
  family: "location",
  secondaryFamilies: ["faction"],
  inferredFamily: null,
});

// ── Mutual edge collapsing ────────────────────────────────────────────────────
const collapsedEdges = collapseBidirectionalEdges([
  { kind: "mention", sourceRef: "lore:a", targetRef: "lore:b", relation: "mentions", matchedText: "Alpha" },
  { kind: "mention", sourceRef: "lore:b", targetRef: "lore:a", relation: "mentions", matchedText: "Beta" },
  { kind: "mention", sourceRef: "lore:a", targetRef: "lore:c", relation: "mentions", matchedText: "Gamma" },
]);
assert.equal(collapsedEdges.length, 2);
assert.equal(collapsedEdges[0]?.bidirectional, true);
assert.equal(collapsedEdges[0]?.reverseMatchedText, "Beta");
assert.equal(collapsedEdges[1]?.bidirectional, false);

// ── Mention extraction & explicit-edge deduplication ──────────────────────────
const nodes: LmGraphNode[] = [
  {
    nodeType: "lore",
    ref: "lore:e1",
    id: "e1",
    lorebookId: "b1",
    lorebookName: "Cyrodiil",
    lorebookCategory: "world",
    name: "Imperial City",
    description: "Capital seat where Tertia works with /guard/i and ox.",
    content: "Tertia Plotia runs her boutique here near Arcane University.",
    keys: ["Imperial City", "IC", "/imperial\\s+city/i"],
    secondaryKeys: [],
    tag: "location, faction",
    family: "location",
    secondaryFamilies: ["faction"],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: { e2: "contains" },
  },
  {
    nodeType: "lore",
    ref: "lore:e2",
    id: "e2",
    lorebookId: "b1",
    lorebookName: "Cyrodiil",
    lorebookCategory: "world",
    name: "Arcane University",
    description: "",
    content: "Mages Guild headquarters inside the capital.",
    keys: ["University"],
    secondaryKeys: [],
    tag: "location",
    family: "location",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "character",
    ref: "char:c1",
    id: "c1",
    name: "Tertia Plotia",
    description: "Tailor",
    aliases: ["Tertia"],
    family: "character",
  },
  {
    nodeType: "character",
    ref: "char:orphan",
    id: "orphan",
    name: "Orphan Card",
    description: "Unconnected",
    aliases: [],
    family: "character",
  },
  {
    nodeType: "lore",
    ref: "lore:e3",
    id: "e3",
    lorebookId: "b2",
    lorebookName: "Misc",
    lorebookCategory: "world",
    name: "Ox",
    description: "",
    content: "Imperial City merchant notes.",
    keys: ["ox"],
    secondaryKeys: [],
    tag: "",
    family: "lore",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
];

const explicitEdges: LmGraphEdge[] = [
  { kind: "explicit", sourceRef: "lore:e1", targetRef: "lore:e2", relation: "contains" },
];

const mentionEdges = extractMentionEdges(nodes, explicitEdges);
assert.equal(mentionEdges.length, 2, "Explicit pair and <3-char keys must be skipped");
assert.ok(mentionEdges.some((edge) => edge.sourceRef === "lore:e1" && edge.targetRef === "char:c1"));
assert.ok(mentionEdges.some((edge) => edge.sourceRef === "lore:e3" && edge.targetRef === "lore:e1"));

// Unicode word-boundary check: accented names must not match inside larger words.
const unicodeNodes: LmGraphNode[] = [
  {
    nodeType: "lore",
    ref: "lore:u-src-miss",
    id: "u-src-miss",
    lorebookId: "b1",
    lorebookName: "Test",
    lorebookCategory: "world",
    name: "Source Miss",
    description: "",
    content: "Mentions XÉlara and ÉlaraX only.",
    keys: ["Miss"],
    secondaryKeys: [],
    tag: "",
    family: "lore",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "lore",
    ref: "lore:u-src-hit",
    id: "u-src-hit",
    lorebookId: "b1",
    lorebookName: "Test",
    lorebookCategory: "world",
    name: "Source Hit",
    description: "",
    content: "Speaks with Élara at dawn.",
    keys: ["Hit"],
    secondaryKeys: [],
    tag: "",
    family: "lore",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "character",
    ref: "char:elara-uni",
    id: "elara-uni",
    name: "Élara",
    description: "",
    aliases: [],
    family: "character",
  },
];
const unicodeMentions = extractMentionEdges(unicodeNodes, []);
assert.ok(!unicodeMentions.some((edge) => edge.sourceRef === "lore:u-src-miss" && edge.targetRef === "char:elara-uni"));
assert.ok(unicodeMentions.some((edge) => edge.sourceRef === "lore:u-src-hit" && edge.targetRef === "char:elara-uni"));

// Character aliases and extra card scan text both surface mention edges.
const cardAliasNodes: LmGraphNode[] = [
  {
    nodeType: "lore",
    ref: "lore:deku-entry",
    id: "deku-entry",
    lorebookId: "b1",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "One For All Notes",
    description: "",
    content: "Deku inherited One For All at U.A. High School.",
    keys: ["One For All"],
    secondaryKeys: [],
    tag: "lore",
    family: "lore",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "lore",
    ref: "lore:ua-entry",
    id: "ua-entry",
    lorebookId: "b1",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "U.A. High School",
    description: "",
    content: "Hero academy.",
    keys: ["U.A."],
    secondaryKeys: [],
    tag: "location",
    family: "location",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "character",
    ref: "char:izuku",
    id: "izuku",
    name: "Izuku Midoriya",
    description: "Short bio.",
    aliases: ["Deku"],
    family: "character",
  },
];
const extraScan = new Map([["char:izuku", "Short bio.\nStudent in Class 1-A at U.A. High School."]]);
const cardAliasMentions = extractMentionEdges(cardAliasNodes, [], extraScan);
assert.ok(
  cardAliasMentions.some(
    (edge) => edge.sourceRef === "lore:deku-entry" && edge.targetRef === "char:izuku" && edge.matchedText === "Deku",
  ),
);
assert.ok(cardAliasMentions.some((edge) => edge.sourceRef === "char:izuku" && edge.targetRef === "lore:ua-entry"));

// ── Graph filtering, multi-tag survival, card book links, collapsed books ─────
const payload: LmGraphPayload = {
  lorebooks: [
    {
      id: "b1",
      name: "Cyrodiil",
      description: "",
      category: "world",
      enabled: true,
      entryCount: 2,
      characterIds: ["c1"],
      personaIds: [],
      loaded: true,
    },
    {
      id: "b2",
      name: "Misc",
      description: "",
      category: "world",
      enabled: true,
      entryCount: 1,
      characterIds: [],
      personaIds: [],
      loaded: true,
    },
  ],
  nodes,
  explicitEdges,
  mentionEdges,
  danglingRelationshipCount: 0,
};

const b1NoMentions = buildLorebookGraph(payload, {
  lorebookIds: new Set(["b1"]),
  showMentions: false,
  hideOrphans: true,
});
assert.equal(b1NoMentions.nodes.filter((n) => n.nodeType === "lore").length, 2);
assert.ok(b1NoMentions.nodes.some((n) => n.ref === "book:b1"));
assert.ok(!b1NoMentions.nodes.some((n) => n.ref === "char:orphan"));
assert.ok(
  b1NoMentions.edges.some((e) => e.kind === "book_link" && e.sourceRef === "char:c1" && e.targetRef === "book:b1"),
);
assert.equal(defaultFocus(b1NoMentions, null), "book:b1");
assert.deepEqual([...neighbourhood(b1NoMentions, "lore:e1", 1)].sort(), ["lore:e1", "lore:e2"]);

// Multi-tagged entry ("location, faction") survives hiding "location" while "faction" stays visible.
const hiddenLocGraph = buildLorebookGraph(payload, {
  lorebookIds: new Set(["b1"]),
  hiddenFamilies: new Set(["location"]),
});
assert.ok(hiddenLocGraph.nodes.some((n) => n.ref === "lore:e1"));
assert.ok(!hiddenLocGraph.nodes.some((n) => n.ref === "lore:e2"));

const collapsedB1 = buildLorebookGraph(payload, {
  lorebookIds: new Set(["b1", "b2"]),
  collapsedLorebookIds: new Set(["b1"]),
});
assert.ok(!collapsedB1.nodes.some((n) => n.nodeType === "lore" && n.lorebookId === "b1"));
assert.ok(collapsedB1.nodes.some((n) => n.ref === "book:b1" && n.nodeType === "lorebook" && n.collapsed));
assert.ok(
  collapsedB1.edges.some((e) => e.kind === "mention" && e.sourceRef === "lore:e3" && e.targetRef === "book:b1"),
);

// ── Layout determinism and spread scaling ─────────────────────────────────────
const layoutA = layoutGraph(b1NoMentions, 1, 50, 1);
const layoutB = layoutGraph(b1NoMentions, 1, 50, 1);
assert.deepEqual([...layoutA.positions.entries()], [...layoutB.positions.entries()]);

const layoutWide = layoutGraph(b1NoMentions, 1, 50, 2.2);
const dist = (p: Map<string, { x: number; y: number }>, a: string, b: string) =>
  Math.hypot(p.get(a)!.x - p.get(b)!.x, p.get(a)!.y - p.get(b)!.y);
assert.ok(
  dist(layoutWide.positions, "lore:e1", "lore:e2") > dist(layoutA.positions, "lore:e1", "lore:e2"),
  "Higher spread factor must increase distance between connected nodes",
);

// ── Stage 1 retrieval simulation: keywords, selective, card inheritance, 1-hop, budgets ──
const simNodes: LmGraphNode[] = [
  {
    nodeType: "character",
    ref: "char:izuku",
    id: "izuku",
    name: "Izuku Midoriya",
    description: "",
    aliases: ["Deku"],
    family: "character",
  },
  {
    nodeType: "lore",
    ref: "lore:const",
    id: "const",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "World Rules",
    description: "",
    content: "Quirks are superpowers.",
    keys: [],
    secondaryKeys: [],
    tag: "lore",
    family: "lore",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: true,
    locked: false,
    order: 10,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "lore",
    ref: "lore:deku-lore",
    id: "deku-lore",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "Izuku Entry",
    description: "",
    content: "Deku summary entry.",
    keys: ["Deku", "Izuku"],
    secondaryKeys: [],
    tag: "character",
    family: "character",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "exclude",
    characterFilterIds: ["izuku"],
    relationships: {
      "char:izuku": "represents",
      allmight: "ally_of",
    },
  },
  {
    nodeType: "lore",
    ref: "lore:allmight",
    id: "allmight",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "All Might",
    description: "",
    content: "Symbol of Peace.",
    keys: ["All Might"],
    secondaryKeys: [],
    tag: "character",
    family: "character",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {
      "deku-lore": "ally_of",
    },
  },
  {
    nodeType: "lore",
    ref: "lore:class1a",
    id: "class1a",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "Class 1-A",
    description: "",
    content: "Hero course class.",
    keys: ["Class 1-A"],
    secondaryKeys: [],
    tag: "faction",
    family: "faction",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
  {
    nodeType: "lore",
    ref: "lore:unrelated-student",
    id: "unrelated-student",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "Minoru Mineta",
    description: "",
    content: "Grape juice quirk.",
    keys: ["Mineta"],
    secondaryKeys: [],
    tag: "character",
    family: "character",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: { class1a: "member_of" },
  },
  {
    nodeType: "lore",
    ref: "lore:shie-selective",
    id: "shie-selective",
    lorebookId: "b-sim",
    lorebookName: "MHA",
    lorebookCategory: "world",
    name: "Overhaul Raid",
    description: "",
    content: "Hero operation.",
    keys: ["Overhaul"],
    secondaryKeys: ["Villain"],
    selective: true,
    selectiveLogic: "notAny",
    tag: "quest",
    family: "quest",
    secondaryFamilies: [],
    inferredFamily: null,
    enabled: true,
    constant: false,
    locked: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
  },
];

const simPayload: LmGraphPayload = {
  lorebooks: [
    {
      id: "b-sim",
      name: "MHA",
      description: "",
      category: "world",
      enabled: true,
      entryCount: 6,
      tokenBudget: 200,
      characterIds: [],
      personaIds: [],
      loaded: true,
    },
  ],
  nodes: simNodes,
  explicitEdges: [],
  mentionEdges: [],
  danglingRelationshipCount: 0,
};

const simRes = simulateLorebookRetrieval(simPayload, {
  queryText: "We meet Class 1-A before the Overhaul mission.",
  activeCharacterIds: ["izuku"],
  tokenBudget: 2000,
  maxOneHop: 6,
});

assert.ok(
  simRes.activated.some((a) => a.entry.ref === "lore:const"),
  "Constant entry must activate",
);
assert.ok(
  simRes.activated.some((a) => a.entry.ref === "lore:class1a"),
  "Keyword Class 1-A must activate",
);
assert.ok(
  simRes.activated.some((a) => a.entry.ref === "lore:shie-selective"),
  "Selective notAny triggers when Overhaul present and Villain absent",
);
assert.ok(
  simRes.suppressed.some((s) => s.entry.ref === "lore:deku-lore" && s.reason === "excluded_by_card"),
  "Izuku Entry must be suppressed while Izuku card is active",
);
const allMightSim = simRes.activated.find((a) => a.entry.ref === "lore:allmight");
assert.ok(
  allMightSim && allMightSim.reasons.some((r) => r.kind === "card_inherited"),
  "Active Izuku card must inherit explicit 1-hop links from suppressed represents entry",
);
assert.equal(
  allMightSim?.reasons.filter((r) => r.kind === "card_inherited").length,
  1,
  "Bidirectional ally_of link must emit one deduplicated <-> reason badge",
);
assert.ok(
  allMightSim?.reasons.some((r) => r.detail.includes("↔")),
  "Deduped opposing link reason must use bidirectional arrow",
);

const bm25OnlyRes = simulateLorebookRetrieval(simPayload, {
  queryText: "quirks superpowers symbol peace",
  activeCharacterIds: [],
  tokenBudget: 2000,
  maxOneHop: 6,
});
const bm25Reason = bm25OnlyRes.activated
  .find((a) => a.entry.ref === "lore:allmight")
  ?.reasons.find((r) => r.kind === "bm25");
assert.ok(
  bm25Reason?.matchedTerms?.includes("symbol") && bm25Reason.detail.includes('"symbol"'),
  "BM25 reason must surface matched query terms cleanly",
);

// Stopwords like "while", "all", "might", "watches" must not trigger BM25-only false positives,
// while exact keyword phrases ("All Might") still activate cleanly.
const fillerRes = simulateLorebookRetrieval(simPayload, {
  queryText: "While all people might watch something, someone mentions a grape juice quirk.",
  activeCharacterIds: [],
  tokenBudget: 2000,
  maxOneHop: 0,
  maxTextHits: 0,
});
assert.ok(
  !fillerRes.activated.some((a) => a.entry.ref === "lore:unrelated-student"),
  "maxTextHits=0 must suppress BM25-only matches cleanly",
);

const exactPhraseThroughStopwords = simulateLorebookRetrieval(simPayload, {
  queryText: "All Might watches while everyone steps forward.",
  activeCharacterIds: [],
  tokenBudget: 2000,
  maxOneHop: 0,
  maxTextHits: 5,
});
assert.ok(
  exactPhraseThroughStopwords.activated.some(
    (a) => a.entry.ref === "lore:allmight" && a.reasons.some((r) => r.kind === "keyword"),
  ),
  "Exact keyword phrase 'All Might' must still activate even when its words are BM25 stopwords",
);
assert.ok(
  !exactPhraseThroughStopwords.activated.some((a) => a.entry.ref === "lore:class1a"),
  "Entries without non-stopword matches must not false-trigger via stopwords",
);
assert.ok(
  !simRes.activated.some((a) => a.entry.ref === "lore:unrelated-student"),
  "Incoming member_of links from Class 1-A must not flood unrelated students",
);
// Round 5: is_a / member_of follow outgoing links only. Even with words of his own in the scene ("grape juice"),
// Mineta doesn't ride in on Class 1-A; named himself, he brings Class 1-A.
{
  const round5Query = { activeCharacterIds: ["izuku"], tokenBudget: 2000 };
  const withEvidence = simulateLorebookRetrieval(simPayload, {
    ...round5Query,
    queryText: "We meet Class 1-A before the Overhaul mission. Someone spilled grape juice.",
    maxTextHits: 0,
    maxOneHop: 6,
  });
  assert.ok(
    !withEvidence.activated.some((a) => a.entry.ref === "lore:unrelated-student"),
    "kind/group → member never comes in by 1-hop, even with text evidence",
  );
  const named = simulateLorebookRetrieval(simPayload, {
    ...round5Query,
    queryText: "Mineta waits by the gate.",
    maxTextHits: 0,
    maxOneHop: 6,
  });
  const group = named.activated.find((a) => a.entry.ref === "lore:class1a");
  assert.equal(group?.tier, "graph_1hop", "member → group comes in by 1-hop");
  assert.ok(
    group?.reasons.some((r) => r.detail.endsWith("member_of ← Minoru Mineta")),
    JSON.stringify(group?.reasons),
  );
}

// Round 5 (B tests): located_in follows outgoing links only. The World State naming a town brings the town, never
// every place in it; a place named in the scene brings its town.
{
  const template = simNodes.find((node) => node.ref === "lore:class1a") as LmEntryNode;
  const place = (id: string, name: string, relationships: Record<string, string>) => ({
    ...template,
    ref: `lore:${id}`,
    id,
    name,
    keys: [name],
    content: `${name}.`,
    tag: "location",
    family: "location" as const,
    relationships,
  });
  const townPayload: LmGraphPayload = {
    ...simPayload,
    nodes: [place("konoha", "Konoha", {}), place("memorial", "Memorial Stone", { konoha: "located_in" })],
  };
  const inTown = simulateLorebookRetrieval(townPayload, {
    queryText: "They walk on.",
    activeLocationText: "Konoha village streets",
    activeCharacterIds: [],
    tokenBudget: 2000,
    maxOneHop: 6,
  });
  assert.ok(
    inTown.activated.some((a) => a.entry.ref === "lore:konoha"),
    "the World State location matches the town",
  );
  assert.ok(
    !inTown.activated.some((a) => a.entry.ref === "lore:memorial"),
    "a town never brings the places located in it",
  );
  const atStone = simulateLorebookRetrieval(townPayload, {
    queryText: "They walk on.",
    activeLocationText: "Memorial Stone",
    activeCharacterIds: [],
    tokenBudget: 2000,
    maxOneHop: 6,
  });
  assert.equal(
    atStone.activated.find((a) => a.entry.ref === "lore:konoha")?.tier,
    "graph_1hop",
    "a place brings the town it is located in",
  );
}

const tightBudgetRes = simulateLorebookRetrieval(simPayload, {
  queryText: "We meet Class 1-A before the Overhaul mission.",
  activeCharacterIds: ["izuku"],
  tokenBudget: 15,
  maxOneHop: 6,
});
assert.ok(
  tightBudgetRes.suppressed.some((s) => s.reason === "over_budget"),
  "Entries exceeding token budget must move to suppressed over_budget",
);

// ── Per-book token budget override (Slice 2b) ─────────────────────────────────
const overriddenBookBudgetRes = simulateLorebookRetrieval(simPayload, {
  queryText: "We meet Class 1-A before the Overhaul mission.",
  activeCharacterIds: ["izuku"],
  tokenBudget: 5000,
  maxOneHop: 6,
  respectBookBudgets: false,
  bookTokenBudgets: { "b-sim": 20 },
});
assert.ok(
  overriddenBookBudgetRes.suppressed.some((s) => s.reason === "over_budget"),
  "Compendium per-book token budget override must cap entries even when global budget is large",
);

// ── One-hop cap counts only activated neighbours; disabled lorebooks are suppressed ──
const simQuery = {
  queryText: "We meet Class 1-A before the Overhaul mission.",
  activeCharacterIds: ["izuku"],
  tokenBudget: 2000,
};
const extraAlly = {
  ...(simNodes.find((n) => n.ref === "lore:allmight") as LmEntryNode),
  ref: "lore:extra-ally",
  id: "extra-ally",
  name: "Extra Ally",
  keys: [],
  relationships: {},
};
const oneHopPayload: LmGraphPayload = {
  ...simPayload,
  nodes: simPayload.nodes
    .map((n) =>
      n.ref === "lore:deku-lore" && n.nodeType === "lore"
        ? { ...n, relationships: { ...n.relationships, "extra-ally": "ally_of" } }
        : n,
    )
    .concat([extraAlly]),
};
const oneHopFull = simulateLorebookRetrieval(oneHopPayload, { ...simQuery, maxOneHop: 6 });
const oneHopActivatedCount = oneHopFull.activated.filter((a) => a.tier === "graph_1hop").length;
assert.ok(oneHopActivatedCount >= 2, "Fixture must activate at least two 1-hop neighbours");
// The badge sits on the neighbour: deku-lore ally_of extra-ally reads "ally_of ← <Deku>" on Extra Ally (round 4:
// "is_a → Lee Clan" on Clan read as if Clan were a Lee Clan).
{
  const dekuName = (oneHopPayload.nodes.find((n) => n.ref === "lore:deku-lore") as LmEntryNode).name;
  const extra = oneHopFull.activated.find((a) => a.entry.ref === "lore:extra-ally");
  assert.ok(extra, "Extra Ally comes in by 1-hop");
  assert.ok(
    extra?.reasons.some((r) => r.detail.endsWith(`ally_of ← ${dekuName}`)),
    `arrow reads from the neighbour: ${(extra?.reasons ?? []).map((r) => r.detail).join(" | ")}`,
  );
}
const oneHopCapped = simulateLorebookRetrieval(oneHopPayload, { ...simQuery, maxOneHop: 1 });
assert.equal(
  oneHopCapped.activated.filter((a) => a.tier === "graph_1hop").length,
  1,
  "One-hop cap must hold exactly the configured number of activated neighbours",
);
assert.ok(
  oneHopCapped.suppressed.some((s) => s.detail.includes("One-hop limit")),
  "Neighbours beyond the one-hop cap must be suppressed with a clear reason",
);
// The one-hop cap must also hold under a tight token budget.
const oneHopTight = simulateLorebookRetrieval(oneHopPayload, { ...simQuery, maxOneHop: 1, tokenBudget: 15 });
assert.ok(
  oneHopTight.activated.filter((a) => a.tier === "graph_1hop").length <= 1,
  "One-hop cap must hold under a tight token budget",
);

// Backfill: inflate the top-ranked neighbour past the budget; the next neighbour must take the single slot.
{
  const ranked = oneHopFull.activated.filter((a) => a.tier === "graph_1hop");
  const top = ranked[0]!;
  const second = ranked[1]!;
  const inflated: LmGraphPayload = {
    ...oneHopPayload,
    nodes: oneHopPayload.nodes.map((n) =>
      n.ref === top.entry.ref && n.nodeType === "lore" ? { ...n, content: n.content + " lore".repeat(4000) } : n,
    ),
  };
  const nonHopTokens = oneHopFull.activated
    .filter((a) => a.tier !== "graph_1hop")
    .reduce((sum, a) => sum + a.tokens, 0);
  const backfill = simulateLorebookRetrieval(inflated, {
    ...simQuery,
    maxOneHop: 1,
    tokenBudget: nonHopTokens + second.tokens + 5,
  });
  const backfillHops = backfill.activated.filter((a) => a.tier === "graph_1hop");
  assert.equal(backfillHops.length, 1, "One slot must still be filled when the top neighbour is over budget");
  assert.notEqual(backfillHops[0]!.entry.ref, top.entry.ref, "The over-budget top neighbour must not activate");
}

// Relation catalog and the symmetric set used for implied-mutual card links must agree.
for (const relation of LM_RELATIONS) {
  assert.equal(
    SYMMETRIC_RELATIONS.has(relation.value),
    relation.symmetric,
    `Relation ${relation.value}: catalog symmetry must match SYMMETRIC_RELATIONS`,
  );
}
assert.ok(LM_RELATION_VALUES.includes("is_a") && LM_RELATION_VALUES.includes("leads"), "is_a and leads are offered");

const disabledBookRes = simulateLorebookRetrieval(
  { ...simPayload, lorebooks: simPayload.lorebooks.map((b) => ({ ...b, enabled: false })) },
  { ...simQuery, maxOneHop: 6 },
);
assert.equal(disabledBookRes.activated.length, 0, "Entries of a disabled lorebook must not activate");
assert.ok(
  disabledBookRes.suppressed.some((s) => s.reason === "disabled" && s.detail === "Lorebook is disabled"),
  "Disabled lorebook entries must be suppressed with the lorebook reason",
);

// ── Linked cast discovery helper (Slice 2b) ───────────────────────────────────
const linkedCast = collectLinkedCastForLorebooks(
  [
    {
      id: "b-main",
      name: "Main Book",
      description: "",
      category: "world",
      enabled: true,
      entryCount: 1,
      tokenBudget: null,
      characterIds: ["char-owner"],
      personaIds: ["persona-owner"],
      loaded: true,
    },
    {
      id: "b-other",
      name: "Other Book",
      description: "",
      category: "world",
      enabled: true,
      entryCount: 1,
      tokenBudget: null,
      characterIds: ["char-ignored"],
      personaIds: [],
      loaded: true,
    },
  ],
  new Set(["b-main"]),
  [
    {
      nodeType: "lore",
      ref: "lore:x1",
      id: "x1",
      lorebookId: "b-main",
      lorebookName: "Main Book",
      lorebookCategory: "world",
      name: "Entry X",
      description: "",
      content: "",
      keys: [],
      secondaryKeys: [],
      tag: "",
      family: "lore",
      secondaryFamilies: [],
      inferredFamily: null,
      enabled: true,
      constant: false,
      locked: false,
      characterFilterMode: "exclude",
      characterFilterIds: ["char-filtered"],
      relationships: { "char:char-rel": "represents", "persona:persona-rel": "related_to" },
    },
  ],
);
assert.deepEqual(linkedCast.characterIds.sort(), ["char-filtered", "char-owner", "char-rel"]);
assert.deepEqual(linkedCast.personaIds.sort(), ["persona-owner", "persona-rel"]);

// ── Compendium persistence store & chat bindings (Slice 2b) ───────────────────
function makeMemoryDocStore(): LorebookManagerDocumentStore {
  const docs = new Map<string, LorebookManagerDocumentRecord>();
  return {
    async list(packageId, kind) {
      return [...docs.values()].filter((d) => d.packageId === packageId && d.kind === kind);
    },
    async getById(packageId, id) {
      const doc = docs.get(id);
      return doc && doc.packageId === packageId ? { ...doc } : null;
    },
    async create(input) {
      const record: LorebookManagerDocumentRecord = { ...input, revision: 1 };
      docs.set(record.id, record);
      return { ...record };
    },
    async update(input) {
      const existing = docs.get(input.id);
      if (!existing || existing.packageId !== input.packageId || existing.revision !== input.expectedRevision) {
        return null;
      }
      const next: LorebookManagerDocumentRecord = {
        ...existing,
        name: input.name,
        description: input.description,
        data: input.data,
        revision: existing.revision + 1,
        updatedAt: input.updatedAt,
      };
      docs.set(next.id, next);
      return { ...next };
    },
    async remove(packageId, id, expectedRevision) {
      const existing = docs.get(id);
      if (!existing || existing.packageId !== packageId || existing.revision !== expectedRevision) {
        return false;
      }
      docs.delete(id);
      return true;
    },
  };
}

async function runStoreChecks() {
  const store = makeMemoryDocStore();
  await assert.rejects(
    () => createCompendium(store, { name: "   " }),
    (err: unknown) => err instanceof CompendiumStoreError && err.statusCode === 400,
    "Empty Compendium name must fail with 400",
  );

  const created = await createCompendium(store, {
    name: "U.A. Arc",
    description: "School festival",
    lorebookIds: ["mha", "mha"],
    characterIds: ["izuku"],
    personaIds: ["p1"],
    retrievalSettings: { tokenBudget: 4000, bookTokenBudgets: { mha: 1200 } },
  });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.lorebookIds, ["mha"]);
  assert.equal(created.retrievalSettings.tokenBudget, 4000);
  assert.equal(created.retrievalSettings.bookTokenBudgets.mha, 1200);

  const listed = await listCompendiums(store);
  assert.equal(listed.length, 1);

  const updated = await updateCompendium(store, created.id, {
    name: "U.A. Sports Festival",
    expectedRevision: 1,
    retrievalSettings: { maxTextHits: 2 },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.retrievalSettings.bookTokenBudgets.mha, 1200);
  assert.equal(updated.retrievalSettings.maxTextHits, 2);

  await assert.rejects(
    () => updateCompendium(store, created.id, { name: "Stale", expectedRevision: 1 }),
    (err: unknown) => err instanceof CompendiumStoreError && err.statusCode === 409,
    "Stale expectedRevision must throw 409 conflict",
  );

  const unbound = await getChatCompendiumBinding(store, "chat-42");
  assert.equal(unbound.compendiumId, null);

  await assert.rejects(
    () => setChatCompendiumBinding(store, "chat-42", "compendium:missing"),
    (err: unknown) => err instanceof CompendiumStoreError && err.statusCode === 404,
    "Binding unknown Compendium must fail with 404",
  );

  const bound = await setChatCompendiumBinding(store, "chat-42", created.id);
  assert.equal(bound.compendiumId, created.id);
  const reloadedBinding = await getChatCompendiumBinding(store, "chat-42");
  assert.equal(reloadedBinding.compendiumId, created.id);

  await setChatCompendiumBinding(store, "chat-42", null);
  const clearedBinding = await getChatCompendiumBinding(store, "chat-42");
  assert.equal(clearedBinding.compendiumId, null);

  await deleteCompendium(store, created.id, 2);
  assert.equal((await listCompendiums(store)).length, 0);
}

runStoreChecks()
  .then(() => {
    console.log("lorebook-manager-graph.regression: all assertions passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
