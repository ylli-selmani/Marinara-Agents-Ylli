import assert from "node:assert/strict";
import {
  formatEntityRef,
  parseEntityRef,
  toRelationshipKey,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  buildLorebookGraph,
  classifyEntryFamily,
  defaultFocus,
  extractMentionEdges,
  layoutGraph,
  neighbourhood,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmGraphEdge,
  LmGraphNode,
  LmGraphPayload,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";

// ── EntityRef parsing and relationship keys ───────────────────────────────────
assert.deepEqual(parseEntityRef("entry-123"), { kind: "lore", id: "entry-123", ref: "lore:entry-123" });
assert.deepEqual(parseEntityRef("char:elara"), { kind: "char", id: "elara", ref: "char:elara" });
assert.deepEqual(parseEntityRef("loc:imperial-city"), {
  kind: "loc",
  id: "imperial-city",
  ref: "loc:imperial-city",
});
assert.equal(parseEntityRef("   "), null);
assert.equal(formatEntityRef("persona", "p1"), "persona:p1");
assert.equal(toRelationshipKey("lore:entry-123"), "entry-123");
assert.equal(toRelationshipKey("char:elara"), "char:elara");

// ── Family classification ─────────────────────────────────────────────────────
assert.equal(classifyEntryFamily("location", "world"), "location");
assert.equal(classifyEntryFamily("Guild", "world"), "faction");
assert.equal(classifyEntryFamily("", "npc"), "character");
assert.equal(classifyEntryFamily("artifact", "world"), "item");
assert.equal(classifyEntryFamily("quest", "world"), "quest");
assert.equal(classifyEntryFamily("", "world"), "lore");

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
    tag: "location",
    family: "location",
    enabled: true,
    constant: false,
    locked: false,
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
    enabled: true,
    constant: false,
    locked: false,
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
    nodeType: "lore",
    ref: "lore:e3",
    id: "e3",
    lorebookId: "b2",
    lorebookName: "Misc",
    lorebookCategory: "world",
    name: "Ox",
    description: "",
    content: "Short name should not false-match.",
    keys: ["ox"],
    secondaryKeys: [],
    tag: "",
    family: "lore",
    enabled: true,
    constant: false,
    locked: false,
    relationships: {},
  },
];

const explicitEdges: LmGraphEdge[] = [
  { kind: "explicit", sourceRef: "lore:e1", targetRef: "lore:e2", relation: "contains" },
];

const mentionEdges = extractMentionEdges(nodes, explicitEdges);
assert.equal(mentionEdges.length, 1, "Explicit pair (e1 -> e2) and <3-char keys (Ox, IC) must be skipped");
assert.equal(mentionEdges[0]?.sourceRef, "lore:e1");
assert.equal(mentionEdges[0]?.targetRef, "char:c1");

// ── Graph filtering, neighbourhood, and deterministic layout ──────────────────
const payload: LmGraphPayload = {
  lorebooks: [
    { id: "b1", name: "Cyrodiil", description: "", category: "world", enabled: true, entryCount: 2 },
    { id: "b2", name: "Misc", description: "", category: "world", enabled: true, entryCount: 1 },
  ],
  nodes,
  explicitEdges,
  mentionEdges,
  danglingRelationshipCount: 0,
};

const b1Only = buildLorebookGraph(payload, { lorebookIds: new Set(["b1"]), showMentions: false });
assert.equal(b1Only.nodes.filter((n) => n.nodeType === "lore").length, 2);
assert.equal(b1Only.edges.length, 1);
assert.equal(defaultFocus(b1Only, null), "lore:e1");
assert.deepEqual([...neighbourhood(b1Only, "lore:e1", 1)].sort(), ["lore:e1", "lore:e2"]);

const layoutA = layoutGraph(b1Only, 1, 50);
const layoutB = layoutGraph(b1Only, 1, 50);
assert.deepEqual([...layoutA.positions.entries()], [...layoutB.positions.entries()]);

console.log("lorebook-manager-graph.regression: all assertions passed");
