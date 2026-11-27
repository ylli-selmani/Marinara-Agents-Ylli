import assert from "node:assert/strict";
import { representedCardIds } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  LM_STUB_FIELDS,
  stubSheetLines,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/sheets.js";
import {
  simulateLorebookRetrieval,
  estimateEntryTokens,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/retrieval.js";
import {
  buildLorebookGraph,
  drawnRadius,
  layoutGraph,
  nodeAtPoint,
  seatedStubCards,
  seatStubPositions,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmEntryNode,
  LmGraphPayload,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";
import { formatLiveLore } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import { gateCandidates } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/stage2-gate.js";
import { crawlerUserPrompt } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/crawler.js";
import { runArchivist } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/archivist.js";
import {
  createCompendium,
  setChatCompendiumBinding,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import { listProposals } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/proposals-store.js";
import {
  refreshLiveClaims,
  resetLiveClaims,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import {
  buildLorebookManagerGraphPayload,
  lorebookManagerRoutes,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/routes.js";
import { saveSettings } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/settings-store.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";

const stub: LmEntryNode = {
  nodeType: "lore",
  ref: "lore:stub",
  id: "stub",
  lorebookId: "cast",
  lorebookName: "Cast",
  lorebookCategory: "character",
  name: "Aster",
  description: "Stub",
  content: "Repeated card prose.\nNote: stray prose\nStatus: Wounded\nCurrently: Resting\nAge: 30\nRole: ",
  keys: ["Aster"],
  secondaryKeys: [],
  tag: "character",
  family: "character",
  secondaryFamilies: [],
  inferredFamily: null,
  enabled: true,
  constant: false,
  locked: false,
  characterFilterMode: "exclude",
  characterFilterIds: ["aster"],
  relationships: { "char:aster": "represents" },
};
const card = {
  nodeType: "character" as const,
  ref: "char:aster",
  id: "aster",
  name: "Aster",
  description: "Card prose",
  aliases: [],
  family: "character" as const,
};
const payload: LmGraphPayload = {
  lorebooks: [
    {
      id: "cast",
      name: "Cast",
      description: "",
      category: "character",
      enabled: true,
      loaded: true,
      entryCount: 1,
      characterIds: [],
      personaIds: [],
    },
  ],
  nodes: [stub, card],
  explicitEdges: [{ sourceRef: stub.ref, targetRef: card.ref, relation: "represents", kind: "explicit" }],
  mentionEdges: [],
  danglingRelationshipCount: 0,
};
const input = {
  queryText: "Aster repeated card prose",
  activeCharacterIds: ["aster"],
  tokenBudget: 2000,
  maxOneHop: 0,
  maxTextHits: 10,
  semanticScores: { [stub.ref]: 1 },
};
const run = (entry: LmEntryNode, activeCharacterIds = input.activeCharacterIds) =>
  simulateLorebookRetrieval({ ...payload, nodes: [entry, card] }, { ...input, activeCharacterIds });
assert.deepEqual(stubSheetLines(stub.content), ["Status: Wounded", "Currently: Resting", "Age: 30"]);
assert.deepEqual(stubSheetLines("status: Fine\nhttps://x: y\nNote: no\nCurrently: "), ["status: Fine"]);
assert.deepEqual(representedCardIds({ "persona:p": "represents" }), []);
const result = run(stub);
const item = result.activated[0]!;
assert.ok(item, "active stub must activate via its sheet-only branch");
assert.equal(item.tier, "card");
assert.deepEqual(
  item.reasons.map((reason) => reason.kind),
  ["card_sheet"],
  "no BM25, keyword or semantic score for a seated card sheet",
);
assert.equal(item.injectedContent, "Aster, current state:\nStatus: Wounded\nCurrently: Resting\nAge: 30");
assert.equal(
  run({ ...stub, characterFilterIds: ["aster", "aster"] }).activated[0]?.injectedContent,
  item.injectedContent,
);
const sameNameCards = simulateLorebookRetrieval(
  {
    ...payload,
    nodes: [
      {
        ...stub,
        characterFilterIds: ["aster", "twin", "aster"],
        relationships: { "char:aster": "represents", "char:twin": "represents" },
      },
      card,
      { ...card, id: "twin", ref: "char:twin" },
    ],
  },
  { ...input, activeCharacterIds: ["aster", "twin"] },
);
assert.equal(sameNameCards.activated[0]?.injectedContent, item.injectedContent);
assert.equal(item.tokens, estimateEntryTokens({ name: stub.name, content: item.injectedContent! }));
assert.equal(gateCandidates(result).length, 0);
assert.equal(
  formatLiveLore(result, payload, { activeCharacterIds: ["aster"] }),
  `<world_info>\n${item.injectedContent}\n</world_info>`,
);
for (const content of ["Status: ", "Repeated card prose.", "Note: this is not a sheet"]) {
  const suppressed = run({ ...stub, content });
  assert.equal(suppressed.activated.length, 0);
  assert.equal(suppressed.suppressed[0]?.reason, "excluded_by_card");
}
assert.equal(
  run({ ...stub, characterFilterIds: ["aster", "other"] }, ["aster", "other"]).suppressed[0]?.reason,
  "excluded_by_card",
);
const inactive = run(stub, []);
assert.ok(inactive.activated[0]?.reasons.some((reason) => reason.kind === "keyword"));
assert.equal(inactive.activated[0]?.injectedContent, undefined);
assert.equal(
  formatLiveLore(inactive, payload, { activeCharacterIds: [] }),
  `<world_info>\n${stub.content.trim()}\n</world_info>`,
);
for (const change of [
  { enabled: false },
  { characterFilterMode: "exclude" as const, characterFilterIds: ["aster", "other"] },
]) {
  assert.equal(run({ ...stub, ...change }, ["aster", "other"]).activated.length, 0);
}
assert.equal(
  simulateLorebookRetrieval(
    { ...payload, lorebooks: payload.lorebooks.map((book) => ({ ...book, enabled: false })) },
    input,
  ).activated.length,
  0,
);
// A huge excluded stub must not alter BM25 scores of the eligible corpus.
const neighbour = {
  ...stub,
  ref: "lore:neighbour",
  id: "neighbour",
  name: "Neighbour",
  content: "violet harbour ship",
  keys: [],
  characterFilterMode: "any" as const,
  relationships: {},
};
const background = Array.from({ length: 12 }, (_, i) => ({
  ...neighbour,
  ref: `lore:background-${i}`,
  id: `background-${i}`,
  content: "remote mountain orchard",
}));
const bm25 = (nodes: LmGraphPayload["nodes"]) =>
  simulateLorebookRetrieval({ ...payload, nodes: [...nodes, ...background] }, { ...input, queryText: "violet harbour" })
    .activated.find((hit) => hit.entry.ref === neighbour.ref)
    ?.reasons.find((reason) => reason.kind === "bm25")?.score;
assert.equal(
  bm25([neighbour, card, { ...stub, content: stub.content + "\n" + "violet ".repeat(1000) }]),
  bm25([neighbour, card]),
);
assert.ok(bm25([neighbour, card])! > 0);
const ordered = simulateLorebookRetrieval(
  {
    ...payload,
    nodes: [
      stub,
      card,
      { ...neighbour, ref: "lore:constant", constant: true },
      { ...neighbour, ref: "lore:location" },
      { ...neighbour, ref: "lore:direct", keys: ["Aster"] },
    ],
  },
  { ...input, currentLocationEntryRefs: ["lore:location"] },
);
assert.deepEqual(
  ordered.activated.map((hit) => hit.tier),
  ["constant", "location", "card", "direct"],
);

const graph = buildLorebookGraph(payload, { hideOrphans: true });
const seats = seatedStubCards(graph);
assert.equal(seats.get(stub.ref), card.ref);
assert.equal(graph.edges.length, 1, "represents edge remains available to graph filters and focus");
const drawnStub = graph.nodes.find((node) => node.ref === stub.ref)!;
const drawnCard = graph.nodes.find((node) => node.ref === card.ref)!;
assert.equal(drawnRadius(drawnStub, true), drawnRadius(drawnStub) * 0.6);
assert.equal(layoutGraph(graph).positions.has(stub.ref), false);
const normalizedSeatOffset = (zoom: number) => {
  const scale = Math.min(1.3, Math.max(0.6, zoom));
  const point = seatStubPositions(graph, new Map([[card.ref, { x: 0, y: 0 }]]), scale / zoom).get(stub.ref)!;
  return (point.y * zoom) / scale;
};
assert.ok(
  Math.abs(normalizedSeatOffset(0.25) - normalizedSeatOffset(3)) < 1e-9,
  "stub seat offset must follow screen scale at both zooms",
);
for (const zoom of [0.25, 3]) {
  // A well-connected stub is large enough for its overlap to extend past the centers' midpoint.
  const overlapStub = { ...drawnStub, degree: 8 };
  const overlapGraph = { ...graph, nodes: graph.nodes.map((node) => (node.ref === stub.ref ? overlapStub : node)) };
  const screenScale = Math.min(1.3, Math.max(0.6, zoom));
  const edgeScale = screenScale / zoom;
  const cardPoint = { x: 240, y: 300 };
  const positions = seatStubPositions(
    overlapGraph,
    new Map([
      [card.ref, cardPoint],
      [stub.ref, { x: -999, y: -999 }],
    ]),
    edgeScale,
  );
  const position = positions.get(stub.ref)!;
  const offset = ((position.y - cardPoint.y) * zoom) / screenScale;
  assert.ok(Math.abs(offset + drawnRadius(drawnCard) + 1) < 1e-9);
  const radiusOf = (ref: string) => drawnRadius(ref === stub.ref ? overlapStub : drawnCard, seats.has(ref)) * edgeScale;
  // This point lies in both shapes and nearer the card: the stub still owns the overlap.
  const overlap = { x: position.x * zoom, y: (position.y + drawnRadius(overlapStub, true) * edgeScale * 0.98) * zoom };
  assert.ok(Math.hypot(overlap.x - position.x * zoom, overlap.y - position.y * zoom) < radiusOf(stub.ref) * zoom);
  assert.ok(
    Math.hypot(overlap.x - cardPoint.x * zoom, overlap.y - cardPoint.y * zoom) <
      Math.hypot(overlap.x - position.x * zoom, overlap.y - position.y * zoom),
    "overlap point must be strictly nearer the card center",
  );
  assert.equal(nodeAtPoint(positions, radiusOf, { k: zoom, x: 0, y: 0 }, overlap, 44, seats), stub.ref);
  assert.equal(
    nodeAtPoint(
      positions,
      radiusOf,
      { k: zoom, x: 0, y: 0 },
      { x: cardPoint.x * zoom, y: cardPoint.y * zoom },
      44,
      seats,
    ),
    card.ref,
  );
  const moved = seatStubPositions(graph, new Map([[card.ref, { x: 270, y: 360 }]]), edgeScale).get(stub.ref)!;
  assert.equal(moved.x - position.x, 30);
  assert.equal(moved.y - position.y, 60);
}
const fannedGraph = {
  ...graph,
  nodes: [...graph.nodes, { ...drawnStub, ref: "lore:second" }, { ...drawnStub, ref: "lore:third" }],
};
const fanned = seatStubPositions(fannedGraph, new Map([[card.ref, { x: 0, y: 0 }]]), 1);
assert.notEqual(fanned.get(stub.ref)?.x, fanned.get("lore:second")?.x);
assert.deepEqual(
  [...fanned.keys()].filter((ref) => ref !== card.ref),
  fannedGraph.nodes.filter((node) => node.nodeType === "lore").map((node) => node.ref),
);
const fanSeats = seatedStubCards(fannedGraph);
const firstFan = fanned.get(stub.ref)!;
const middleFan = fanned.get("lore:second")!;
const fanOverlap = { x: firstFan.x * 0.55 + middleFan.x * 0.45, y: firstFan.y * 0.55 + middleFan.y * 0.45 };
assert.ok(Math.hypot(fanOverlap.x - firstFan.x, fanOverlap.y - firstFan.y) < drawnRadius(drawnStub, true));
assert.ok(Math.hypot(fanOverlap.x - middleFan.x, fanOverlap.y - middleFan.y) < drawnRadius(drawnStub, true));
assert.equal(
  nodeAtPoint(fanned, () => drawnRadius(drawnStub, true), { k: 1, x: 0, y: 0 }, fanOverlap, 44, fanSeats),
  stub.ref,
  "nearest overlapping fanned stub wins",
);
const withoutCard = { ...graph, nodes: [drawnStub], edges: [] };
assert.equal(seatedStubCards(withoutCard).size, 0);
assert.ok(layoutGraph(withoutCard).positions.has(stub.ref));
const linkedGraph = {
  ...graph,
  nodes: [...graph.nodes, { ...neighbour, degree: 1 }],
  edges: [
    ...graph.edges,
    { sourceRef: stub.ref, targetRef: neighbour.ref, relation: "ally_of", kind: "explicit" as const },
  ],
};
const remappedGraph = {
  ...linkedGraph,
  nodes: linkedGraph.nodes.filter((node) => node.ref !== stub.ref),
  edges: [{ sourceRef: card.ref, targetRef: neighbour.ref, relation: "ally_of", kind: "explicit" as const }],
};
assert.deepEqual(layoutGraph(linkedGraph).positions, layoutGraph(remappedGraph).positions);
assert.ok(!crawlerUserPrompt([{ ...stub, content: "" }], (ref) => ref).includes("missing sheet lines"));
assert.ok(
  !crawlerUserPrompt([{ ...stub, relationships: {}, content: "" }], (ref) => ref).includes("missing sheet lines"),
);
assert.ok(
  crawlerUserPrompt([{ ...stub, content: "Aster rests." }], (ref) => ref).includes(
    `missing sheet lines: ${LM_STUB_FIELDS.join(", ")}`,
  ),
);

function memoryDocuments(): LorebookManagerDocumentStore {
  const docs = new Map<string, LorebookManagerDocumentRecord>();
  return {
    async list(packageId, kind) {
      return [...docs.values()].filter((doc) => doc.packageId === packageId && doc.kind === kind);
    },
    async getById(packageId, id) {
      const doc = docs.get(id);
      return doc?.packageId === packageId ? doc : null;
    },
    async create(input) {
      const doc = { ...input, revision: 1 };
      docs.set(doc.id, doc);
      return doc;
    },
    async update(input) {
      const doc = docs.get(input.id);
      if (!doc || doc.revision !== input.expectedRevision) return null;
      const next = { ...doc, ...input, revision: doc.revision + 1 };
      docs.set(next.id, next);
      return next;
    },
    async remove(_packageId, id) {
      return docs.delete(id);
    },
  };
}
async function main() {
  const documents = memoryDocuments();
  const names = ["Aster", "Beryl", "Cedar", "Dorian", "Elowen", "Farren", "Galen", "Nerissa"];
  const cards = names.map((name) => ({
    id: name.toLowerCase(),
    data: { data: { name, nameAliases: ["Star", "Dawn", "Light", "Fourth"] } },
    comment: "",
  }));
  const books = [
    {
      id: "cast",
      data: { name: "Cast", category: "character", enabled: true },
      entries: [] as Record<string, unknown>[],
    },
    {
      id: "world",
      data: { name: "World", category: "world", enabled: true },
      entries: [] as Record<string, unknown>[],
    },
    {
      id: "off",
      data: { name: "Disabled", category: "npc", enabled: false },
      entries: [] as Record<string, unknown>[],
    },
  ];
  let sequence = 0;
  let beforeWrite: (() => Promise<void>) | undefined;
  let prompt = "";
  let creates: Array<Record<string, unknown>> = [
    { name: "Aster", category: "character", fields: [{ field: "Role", value: "Scout" }] },
    { name: "Nerissa", category: "character", fields: [{ field: "Role", value: "Scout" }] },
  ];
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: {
      documents,
      async getChat(id) {
        return { id, characterIds: cards.map((card) => card.id), personaId: null };
      },
      async listMessages() {
        return [
          { id: "u", role: "user", content: "Aster rests.", extra: {}, createdAt: "2026-11-27T00:00:00Z" },
          { id: "a", role: "assistant", content: "Aster is healing.", extra: {}, createdAt: "2026-11-27T00:00:01Z" },
        ];
      },
    },
    resources: {
      async listCharacters(ids) {
        return cards.filter((card) => !ids || ids.includes(card.id));
      },
      async listPersonas() {
        return [];
      },
      async listLorebooks(ids) {
        return books.filter((book) => !ids || ids.includes(book.id));
      },
      async createLorebookEntry(lorebookId, data) {
        await beforeWrite?.();
        const id = `stub-${++sequence}`;
        books.find((book) => book.id === lorebookId)!.entries.push({ ...data, id });
        return { id, lorebookId, data };
      },
    },
    languageModels: {
      async resolveForRequest() {
        return {
          connectionId: "fake",
          model: "fake",
          async chatComplete(messages) {
            prompt = messages.find((message) => message.role === "user")!.content;
            const id = /\[(c\d+)\] Aster /.exec(prompt)?.[1];
            return {
              finishReason: "stop",
              content: JSON.stringify({
                updates: [
                  {
                    id,
                    fields: [
                      { field: "Status", value: "Healing" },
                      { field: "Age", value: "31" },
                    ],
                  },
                ],
                creates,
              }),
            };
          },
        };
      },
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  try {
    const compendium = await createCompendium(documents, { name: "Test", lorebookIds: ["cast", "world", "off"] });
    type Reply = { code(status: number): Reply; send(body: unknown): unknown };
    type Handler = (request: { body: unknown }, reply: Reply) => Promise<unknown>;
    const posts = new Map<string, Handler>();
    await lorebookManagerRoutes(
      {
        get() {},
        post(path: string, handler: Handler) {
          posts.set(path, handler);
        },
        put() {},
        patch() {},
        delete() {},
      } as never,
      {},
    );
    const post = async (body: unknown) => {
      let status = 200;
      const reply: Reply = {
        code(value) {
          status = value;
          return this;
        },
        send(body) {
          return body;
        },
      };
      const data = await posts.get("/stubs")!({ body }, reply);
      return { status, data };
    };
    const body = { compendiumId: compendium.id, characterId: "aster", lorebookId: "world" };
    assert.equal((await post({ ...body, compendiumId: "unknown" })).status, 404);
    assert.equal((await post({ ...body, lorebookId: "outside" })).status, 400);
    assert.equal((await post({ ...body, characterId: "missing" })).status, 404);
    const missingBook = books.pop()!;
    assert.equal((await post({ ...body, lorebookId: missingBook.id })).status, 404);
    books.push(missingBook);
    const created = await post(body);
    assert.equal(created.status, 200);
    const entry = books[1]!.entries[0]!;
    assert.deepEqual(entry, {
      id: "stub-1",
      name: "Aster",
      keys: ["Aster", "Star", "Dawn", "Light"],
      tag: "character",
      description: "Stub for the Aster card",
      content: "",
      matchWholeWords: true,
      relationships: { "char:aster": "represents" },
      characterFilterMode: "exclude",
      characterFilterIds: ["aster"],
    });
    assert.equal(
      (await post({ ...body, lorebookId: "cast" })).status,
      409,
      "duplicates checked across all Compendium books",
    );
    const writer = runtime.resources.createLorebookEntry;
    delete runtime.resources.createLorebookEntry;
    assert.equal((await post({ ...body, characterId: "beryl" })).status, 501);
    for (const message of ["content must not be empty", "storage unavailable"]) {
      runtime.resources.createLorebookEntry = async () => {
        throw new Error(message);
      };
      const refused = await post({ ...body, characterId: "beryl" });
      assert.equal(refused.status, 502);
      assert.deepEqual(refused.data, { error: `The Engine refused to create the stub: ${message}` });
    }
    runtime.resources.createLorebookEntry = writer;
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    beforeWrite = async () => {
      started();
      await pending;
    };
    const first = post({ ...body, characterId: "beryl" });
    await entered;
    assert.equal((await post({ ...body, characterId: "beryl" })).status, 409);
    finish();
    assert.equal((await first).status, 200);
    assert.equal(sequence, 2, "concurrent double-create writes exactly one entry");
    beforeWrite = undefined;
    // Five active stubs maximum, including Stage 1 card sheets, and all count toward the candidate cap.
    Object.assign(entry, { content: "Age: 30\nStatus: Wounded" });
    for (const name of names.slice(2, 7)) await post({ ...body, characterId: name.toLowerCase() });
    books[1]!.entries.find((entry) => entry.id === "stub-6")!.content = "Status: Ready";
    books[0]!.entries.push({
      id: "disabled-entry",
      name: "Disabled entry",
      enabled: false,
      content: "",
      relationships: { "char:aster": "represents" },
    });
    books[2]!.entries.push({
      id: "disabled-book",
      name: "Disabled book entry",
      content: "",
      relationships: { "char:aster": "represents" },
    });
    for (let index = 0; index < 30; index++)
      books[0]!.entries.push({
        id: `constant-${index}`,
        name: `Constant ${index}`,
        constant: true,
        content: "Constant lore",
      });
    await setChatCompendiumBinding(documents, "chat", compendium.id);
    await saveSettings(documents, { archivist: { mode: "suggest", readBehind: 0 } });
    await refreshLiveClaims();
    const outcome = await runArchivist("chat", { force: true });
    assert.equal(outcome.status, "done");
    assert.equal(outcome.run?.candidateCount, 25);
    const entriesBlock = /<entries>([\s\S]*?)<\/entries>/.exec(prompt)![1]!;
    assert.equal((entriesBlock.match(/stub of the /g) ?? []).length, 5);
    assert.ok(!entriesBlock.includes("] Farren "), "sixth active card sheet cannot bypass the stub cap");
    assert.equal((entriesBlock.match(/\] Aster /g) ?? []).length, 1, "Stage 1 stub deduped");
    assert.ok(!entriesBlock.includes("Disabled entry") && !entriesBlock.includes("Disabled book entry"));
    assert.ok(prompt.includes("c1 sheet: Role, Affiliation, Relationships, Status, Currently"));
    assert.ok(
      entriesBlock.includes(
        "stub of the Aster card: write only its current state here (the card holds the rest); never create a separate entry for Aster",
      ),
    );
    assert.equal(outcome.run?.updates, 1);
    assert.equal(outcome.run?.creates, 0);
    assert.deepEqual(
      outcome.run?.skipped.filter((skip) => skip.why.startsWith("card has")).map((skip) => skip.why),
      ["card has a stub", "card has no stub yet"],
    );
    const proposals = await listProposals(documents, "pending");
    const update = proposals.find((proposal) => proposal.targetEntryId === entry.id)!;
    assert.ok(update, "Archivist update targets the active card stub");
    assert.deepEqual(
      update.patch.fieldEdits,
      [{ field: "Status", from: "Wounded", to: "Healing" }],
      "card appearance and age cannot be edited in its stub",
    );
    const livePayload = await buildLorebookManagerGraphPayload({
      lorebookIds: new Set(["world"]),
      characterIds: new Set(["aster"]),
      onlyRequested: true,
    });
    const liveResult = simulateLorebookRetrieval(livePayload, input);
    assert.ok(
      formatLiveLore(liveResult, livePayload, { activeCharacterIds: ["aster"] })?.includes("Aster, current state:"),
    );
    // Leave room after the five selected stubs so Stage 1 could otherwise re-add the sixth card sheet.
    books[0]!.entries = books[0]!.entries.filter((entry) => !entry.constant);
    await setChatCompendiumBinding(documents, "stub-cap", compendium.id);
    await refreshLiveClaims();
    const capped = await runArchivist("stub-cap", { force: true });
    assert.equal(capped.run?.candidateCount, 5, "Stage 1 card sheets cannot bypass the five-stub cap");
    const cappedEntries = /<entries>([\s\S]*?)<\/entries>/.exec(prompt)![1]!;
    assert.ok(!cappedEntries.includes("] Farren "));
    const legitimateCreates = [
      ["Aster's Sword", "item"],
      ["Aster's Tavern", "location"],
      ["Team Aster", "faction"],
      ["Saving Aster", "event"],
      ["Aster's Mother", "character"],
    ];
    for (const [index, [name, category]] of legitimateCreates.entries()) {
      creates = [
        {
          name: name!,
          category: category!,
          fields: [
            { field: category === "event" ? "Goal" : category === "character" ? "Role" : "Type", value: "Scout" },
          ],
        },
      ];
      const chatId = `create-${index}`;
      await setChatCompendiumBinding(documents, chatId, compendium.id);
      await refreshLiveClaims();
      const created = await runArchivist(chatId, { force: true });
      assert.equal(created.run?.creates, 1, `${name} must survive the active-card guard`);
      assert.ok((await listProposals(documents, "pending")).some((proposal) => proposal.entryName === name));
    }
    creates = ["  aStEr  ", "  sTaR  "].map((name) => ({
      name,
      category: "character",
      fields: [{ field: "Role", value: "Scout" }],
    }));
    await setChatCompendiumBinding(documents, "exact-card-names", compendium.id);
    await refreshLiveClaims();
    const exact = await runArchivist("exact-card-names", { force: true });
    assert.equal(exact.run?.creates, 0);
    assert.equal(exact.run?.skipped.filter((skip) => skip.why === "card has a stub").length, 2);
  } finally {
    resetLiveClaims();
    release();
  }
  console.log("lorebook-manager-stubs.regression: all assertions passed");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
