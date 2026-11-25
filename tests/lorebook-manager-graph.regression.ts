import assert from "node:assert/strict";
import {
  formatEntityRef,
  parseEntityRef,
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
import { simulateLorebookRetrieval } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
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
assert.equal(classifyEntryFamily("races", "world"), "creature");
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
    relationships: {},
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
assert.ok(
  simRes.activated.some((a) => a.entry.ref === "lore:allmight" && a.reasons.some((r) => r.kind === "card_inherited")),
  "Active Izuku card must inherit explicit 1-hop links from suppressed represents entry",
);
assert.ok(
  !simRes.activated.some((a) => a.entry.ref === "lore:unrelated-student"),
  "Incoming member_of links from Class 1-A must not flood unrelated students",
);

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

console.log("lorebook-manager-graph.regression: all assertions passed");
