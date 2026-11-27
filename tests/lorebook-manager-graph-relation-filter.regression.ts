import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import ts from "typescript";
import { collapseBidirectionalEdges } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/graph-model.js";
import type { LmGraphEdge } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";

// Load only the pure helper: the component's imports need the Engine host.
const source = ts.createSourceFile(
  "LorebookGraph.tsx",
  readFileSync(
    "packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/LorebookGraph.tsx",
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const helper = source.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "filterGraphRelations",
);
assert.ok(helper, "Graph exports the pure relation filter");
const { code } = transformSync(helper.getText(source), { loader: "ts", format: "cjs" });
const module = {
  exports: {} as Pick<
    typeof import("../packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/LorebookGraph.js"),
    "filterGraphRelations"
  >,
};
new Function("module", "exports", code)(module, module.exports);
const { filterGraphRelations } = module.exports;

const edges = collapseBidirectionalEdges([
  { kind: "explicit", sourceRef: "lore:a", targetRef: "lore:b", relation: "part_of" },
  { kind: "explicit", sourceRef: "lore:b", targetRef: "lore:a", relation: "member_of" },
  { kind: "explicit", sourceRef: "lore:c", targetRef: "lore:d", relation: "part_of" },
  { kind: "explicit", sourceRef: "lore:d", targetRef: "lore:c", relation: "part_of" },
  { kind: "explicit", sourceRef: "lore:b", targetRef: "char:e", relation: "related_to" },
  { kind: "mention", sourceRef: "lore:f", targetRef: "lore:a", relation: "mentions" },
  { kind: "book_link", sourceRef: "char:e", targetRef: "book:b1", relation: "linked_lorebook" },
] satisfies LmGraphEdge[]);

// Only shown explicit edges supply options; mutual links count once per relation.
const all = filterGraphRelations(edges, "all");
assert.deepEqual(all.options, [
  { relation: "part_of", count: 2 },
  { relation: "member_of", count: 1 },
  { relation: "related_to", count: 1 },
]);
assert.equal(all.edges, edges, "All preserves the original edge list");
assert.equal(all.refs, null, "All adds no node dimming");

const parts = filterGraphRelations(edges, "part_of");
assert.equal(parts.relation, "part_of");
assert.deepEqual(parts.options, all.options, "Selecting a relation never narrows its options or counts");
assert.deepEqual(parts.edges, [edges[0], edges[1], edges[3], edges[4]]);
assert.deepEqual([...parts.refs!].sort(), ["lore:a", "lore:b", "lore:c", "lore:d"]);
assert.ok(!parts.refs!.has("lore:f"), "Mention-only endpoints dim");
assert.ok(!parts.refs!.has("char:e"), "Endpoints of other relations dim");
assert.ok(!parts.refs!.has("book:b1"), "Book links do not keep endpoints undimmed");

const members = filterGraphRelations(edges, "member_of");
assert.deepEqual([...members.refs!].sort(), ["lore:a", "lore:b"]);
assert.ok(members.edges.includes(edges[0]!), "Either relation matches a combined edge");
const related = filterGraphRelations(edges, "related_to");
assert.deepEqual([...related.refs!].sort(), ["char:e", "lore:b"], "Both endpoint kinds stay undimmed");

const noMentions = edges.filter((edge) => edge.kind !== "mention");
const partsWithoutMentions = filterGraphRelations(noMentions, "part_of");
assert.deepEqual(partsWithoutMentions.options, parts.options);
assert.deepEqual(partsWithoutMentions.refs, parts.refs);
assert.ok(!partsWithoutMentions.edges.some((edge) => edge.kind === "mention"), "Mentions remain off");

// Switching shown books retains a relation only while it still occurs.
const otherBook = [edges[2]!, edges[4]!];
const missing = filterGraphRelations(otherBook, "part_of");
assert.equal(missing.relation, "all");
assert.equal(missing.edges, otherBook);
assert.equal(missing.refs, null);
assert.deepEqual(missing.options, [{ relation: "related_to", count: 1 }]);
assert.equal(filterGraphRelations(otherBook, "related_to").relation, "related_to");
const empty = filterGraphRelations([], "part_of");
assert.deepEqual(empty.options, []);
assert.equal(empty.relation, "all");
assert.equal(empty.refs, null);

console.log("lorebook-manager-graph-relation-filter.regression: all assertions passed");
