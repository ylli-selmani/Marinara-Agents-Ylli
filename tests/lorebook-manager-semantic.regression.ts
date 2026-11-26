/**
 * Slice 3c-1: meaning match. Stage 1 fuses text (BM25) and embedding similarity with reciprocal rank fusion; the server
 * reuses the Engine's entry vectors in the same space, caches the rest in package documents, and never lets a slow or
 * failing embedder break a turn.
 */
import assert from "node:assert/strict";
import { simulateLorebookRetrieval } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmEntryNode,
  LmGraphPayload,
  LmRetrievalInput,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";
import {
  createCompendium,
  setChatCompendiumBinding,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import { refreshLiveClaims } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import { contributeLiveLore } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerEmbeddingHost,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import {
  entryVectorSource,
  indexLorebooks,
  resetSemanticIndexState,
  semanticScoresFor,
  settleBackgroundIndexing,
  VECTOR_DOC_KIND,
  type EntryVectorSource,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/semantic-index.js";

// ---- Pure Stage 1 ------------------------------------------------------------------------------------------------

function lore(id: string, name: string, extra: Partial<LmEntryNode> = {}): LmEntryNode {
  return {
    nodeType: "lore",
    ref: `lore:${id}`,
    id,
    lorebookId: "book",
    lorebookName: "Book",
    lorebookCategory: "world",
    name,
    description: "",
    content: `${name} lore.`,
    keys: [],
    secondaryKeys: [],
    tag: "",
    family: "concept",
    secondaryFamilies: [],
    inferredFamily: false,
    enabled: true,
    constant: false,
    locked: false,
    selective: false,
    selectiveLogic: "and",
    useRegex: false,
    matchWholeWords: true,
    caseSensitive: false,
    order: 100,
    characterFilterMode: "any",
    characterFilterIds: [],
    relationships: {},
    ...extra,
  } as LmEntryNode;
}

function payloadOf(entries: LmEntryNode[]): LmGraphPayload {
  return {
    nodes: entries,
    lorebooks: [
      {
        id: "book",
        name: "Book",
        description: "",
        category: "world",
        enabled: true,
        entryCount: entries.length,
        tokenBudget: null,
        imagePath: null,
        imageCrop: null,
        characterIds: [],
        personaIds: [],
        loaded: true,
      },
    ],
  } as unknown as LmGraphPayload;
}

const baseInput: LmRetrievalInput = {
  queryText: "",
  activeCharacterIds: [],
  tokenBudget: 100_000,
  maxOneHop: 6,
  maxTextHits: 5,
};

function pureStage1() {
  const entries = [
    lore("harbor", "Harbor", { keys: ["harbor"], content: "Ships rest in the harbor." }),
    lore("tempest", "Tempest Sea", {
      content: "Endless gales batter the grey water.",
      relationships: { "lore:lighthouse": "part_of" },
    }),
    lore("lighthouse", "Lighthouse", { content: "A tower of light." }),
    lore("market", "Market", { content: "Spices and silk." }),
  ];
  const payload = payloadOf(entries);
  const input = { ...baseInput, queryText: "We sail into the harbor while a storm rolls over the waves" };

  const textOnly = simulateLorebookRetrieval(payload, input);
  const emptyScores = simulateLorebookRetrieval(payload, { ...input, semanticScores: {} });
  const shape = (result: typeof textOnly) =>
    result.activated.map((item) => [item.entry.ref, item.tier, Math.round(item.score * 1000)]);
  assert.deepEqual(shape(emptyScores), shape(textOnly), "no similarities = the text-only result, unchanged");
  assert.ok(!textOnly.activated.some((item) => item.entry.ref === "lore:tempest"), "no words in common with Tempest");

  const semanticScores = { "lore:tempest": 0.72, "lore:harbor": 0.41, "lore:market": 0.12 };
  const withMeaning = simulateLorebookRetrieval(payload, { ...input, semanticScores });
  const tempest = withMeaning.activated.find((item) => item.entry.ref === "lore:tempest");
  assert.ok(tempest, "a meaning match alone brings Tempest Sea in");
  assert.deepEqual(
    tempest!.reasons.map((reason) => reason.kind),
    ["semantic"],
  );
  assert.match(tempest!.reasons[0]!.detail, /Meaning match 0\.72/u);
  assert.ok(tempest!.score < 2.2, "below the 1-hop seed line");
  assert.ok(
    !withMeaning.activated.some((item) => item.entry.ref === "lore:lighthouse"),
    "a meaning-only hit doesn't pull its linked entries in",
  );
  assert.ok(!withMeaning.activated.some((item) => item.entry.ref === "lore:market"), "below the 0.3 threshold");
  const harbor = withMeaning.activated.find((item) => item.entry.ref === "lore:harbor");
  assert.deepEqual(
    harbor!.reasons.map((reason) => reason.kind),
    ["keyword", "bm25", "semantic"],
    "a keyword hit carries its meaning match as extra evidence",
  );

  const strict = simulateLorebookRetrieval(payload, { ...input, semanticScores, semanticThreshold: 0.8 });
  assert.ok(!strict.activated.some((item) => item.entry.ref === "lore:tempest"), "the threshold is honoured");

  // Cap: meaning-only picks get at most half the text slots, even when they rank higher.
  const pairs = [
    ["alpha", "beta"],
    ["gamma", "delta"],
    ["epsilon", "zeta"],
    ["theta", "kappa"],
  ];
  const textHits = pairs.map(([a, b]) => lore(`t-${a}`, `Note ${a} ${b}`, { content: `${a} ${b} ${a} ${b}.` }));
  const meaningOnly = ["one", "two", "three", "four"].map((word) => lore(`m-${word}`, `Echo ${word}`));
  const capped = simulateLorebookRetrieval(payloadOf([...textHits, ...meaningOnly]), {
    ...baseInput,
    queryText: pairs.flat().join(" "),
    maxTextHits: 4,
    semanticScores: Object.fromEntries(meaningOnly.map((entry, index) => [entry.ref, 0.95 - index * 0.01])),
  });
  const picked = capped.activated.map((item) => item.entry.ref);
  assert.equal(picked.length, 4, `four text slots: ${picked.join(", ")}`);
  assert.equal(picked.filter((ref) => ref.startsWith("lore:m-")).length, 2, "two of them for meaning-only hits");
}

// ---- Server: vectors, cache, fallbacks ---------------------------------------------------------------------------

function makeMemoryDocStore(): LorebookManagerDocumentStore & { docs: Map<string, LorebookManagerDocumentRecord> } {
  const docs = new Map<string, LorebookManagerDocumentRecord>();
  return {
    docs,
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
      if (!existing || existing.revision !== input.expectedRevision) return null;
      const next = { ...existing, ...input, revision: existing.revision + 1 };
      docs.set(next.id, next);
      return { ...next };
    },
    async remove(_packageId, id) {
      return docs.delete(id);
    },
  };
}

// A tiny bag-of-concepts embedder: synonyms share a dimension, so "tempest" and "storm" are close.
const CONCEPTS: Array<RegExp> = [/storm|tempest|gale/u, /sea|wave|water|ocean/u, /ship|sail|boat/u, /fire|flame/u];
function conceptVector(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/gu) ?? [];
  return CONCEPTS.map((pattern) => words.filter((word) => pattern.test(word)).length);
}

const SPACE = "remote:test-model";

function makeHost(overrides: Partial<LorebookManagerEmbeddingHost> = {}) {
  const calls: Array<{ count: number; inputType?: string }> = [];
  const host: LorebookManagerEmbeddingHost = {
    spaceId: SPACE,
    label: "Test model",
    async embed(texts, _signal, inputType) {
      calls.push({ count: texts.length, inputType });
      return texts.map(conceptVector);
    },
    ...overrides,
  };
  return { host, calls };
}

const message = (id: string, role: string, content: string): LorebookManagerMessageRecord => ({
  id,
  role,
  content,
  extra: "{}",
  createdAt: `2026-11-26T00:00:0${id}Z`,
});

async function serverLane() {
  const documents = makeMemoryDocStore();
  let { host, calls } = makeHost();
  const books = [
    {
      id: "coast",
      data: { name: "Coast", category: "world" },
      entries: [
        // Already vectorized by the Engine in the same space: reused, never re-embedded.
        {
          id: "gale",
          name: "Gale Sea",
          content: "Gales churn the grey ocean.",
          embedding: conceptVector("gale ocean"),
          embeddingSpaceId: SPACE,
        },
        // Vectorized by the Engine in another space: the package embeds its own copy.
        {
          id: "harbor",
          name: "Harbor",
          content: "Boats rest here.",
          embedding: [9, 9, 9, 9],
          embeddingSpaceId: "remote:other",
        },
        { id: "forge", name: "Forge", content: "Flame and fire." },
        { id: "secret", name: "Secret", content: "Storm storm storm.", excludeFromVectorization: true },
      ] as Array<Record<string, unknown>>,
    },
  ];
  let messages: LorebookManagerMessageRecord[] = [];
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    async resolveEmbeddings() {
      return host;
    },
    persistence: {
      documents,
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return { id: chatId, name: "Sea chat", characterIds: [], personaId: null };
      },
    },
    resources: {
      async listLorebooks(ids) {
        return ids ? books.filter((book) => ids.includes(book.id)) : books;
      },
      async listCharacters() {
        return [];
      },
      async listPersonas() {
        return [];
      },
    },
  };
  resetSemanticIndexState();
  const release = configureLorebookManagerRuntime(runtime);
  try {
    const sources = (): EntryVectorSource[] =>
      books[0]!.entries
        .map((entry) => entryVectorSource("coast", books[0]!.data, entry))
        .filter((source): source is EntryVectorSource => source !== null);

    // First turn: only the Engine's same-space vector is usable; the rest index in the background.
    const first = await semanticScoresFor(sources(), "A tempest over the waves");
    assert.equal(first.info.status, "used", JSON.stringify(first.info));
    assert.equal(first.info.engineVectorCount, 1);
    assert.equal(first.info.missingCount, 2, "harbor (other space) and forge; the excluded entry is skipped");
    assert.ok((first.scores["lore:gale"] ?? 0) > 0.9, JSON.stringify(first.scores));
    assert.equal(first.scores["lore:secret"], undefined, "excluded from vectorization");
    await settleBackgroundIndexing();
    const vectorDocs = [...documents.docs.values()].filter((doc) => doc.kind === VECTOR_DOC_KIND);
    assert.equal(vectorDocs.length, 1, "one cache document for the book and space");
    assert.equal(
      calls.filter((call) => call.inputType === "document").reduce((sum, call) => sum + call.count, 0),
      2,
      "the two missing entries were embedded as documents, once",
    );

    // Second turn: everything from the Engine or the cache, one query embed (the baseline is cached).
    calls.length = 0;
    const second = await semanticScoresFor(sources(), "A tempest over the waves");
    assert.equal(second.info.vectorCount, 3);
    assert.equal(second.info.missingCount, 0);
    assert.deepEqual(calls, [{ count: 1, inputType: "query" }], "one query text per turn");
    assert.ok((second.scores["lore:forge"] ?? 1) < 0.1, "fire is not a storm");

    // An edited entry's text no longer matches its cached hash: re-embedded, not served stale.
    books[0]!.entries[2]!.content = "Flame, fire and a storm of sparks.";
    const edited = await semanticScoresFor(sources(), "storm");
    assert.equal(edited.info.missingCount, 1);
    await settleBackgroundIndexing();

    // A slow embedder is cut off; the turn goes on with text matching.
    ({ host, calls } = makeHost({ embed: () => new Promise(() => {}) }));
    const slowStarted = Date.now();
    const slow = await semanticScoresFor(sources(), "storm", { timeoutMs: 40 });
    assert.equal(slow.info.status, "timeout");
    assert.ok(Date.now() - slowStarted < 1000);
    assert.deepEqual(slow.scores, {});

    // An embedder that answers null (the host's way of failing) is an error status, not a throw.
    ({ host, calls } = makeHost({ embed: async () => null }));
    const failed = await semanticScoresFor(sources(), "storm");
    assert.equal(failed.info.status, "error");

    // Live: a Compendium with meaning match picks a paraphrase with no word in common, and the run records it.
    ({ host, calls } = makeHost());
    resetSemanticIndexState();
    const compendium = await createCompendium(documents, {
      name: "Coast",
      lorebookIds: ["coast"],
      retrievalSettings: { semanticEnabled: true, queryMessageCount: 1 },
    });
    assert.equal(compendium.retrievalSettings.semanticEnabled, true);
    assert.equal(compendium.retrievalSettings.semanticThreshold, 0.3);
    await setChatCompendiumBinding(documents, "sea", compendium.id);
    await refreshLiveClaims();
    messages = [message("1", "user", "A tempest rises over the waves.")];
    const lore = await contributeLiveLore({ chatId: "sea", chatMeta: {}, mode: "roleplay", wrapFormat: "none" });
    assert.match(lore ?? "", /Gales churn the grey ocean\./u, "found by meaning alone");
    assert.doesNotMatch(lore ?? "", /Storm storm storm/u, "an excluded entry never matches by meaning");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = (
      documents.docs.get("live_run:sea")?.data as {
        runs?: Array<{
          semantic?: { status: string };
          activated: Array<{ ref: string; reasons: Array<{ kind: string }> }>;
        }>;
      }
    )?.runs?.[0];
    assert.equal(run?.semantic?.status, "used");
    assert.deepEqual(
      run?.activated.find((item) => item.ref === "lore:gale")?.reasons.map((reason) => reason.kind),
      ["semantic"],
    );

    // Index now: embeds what's missing in the request and reports it.
    const status = await indexLorebooks(["coast"]);
    assert.equal(status.total, 4);
    assert.equal(status.excluded, 1);
    assert.deepEqual(status.excludedBooks, [], "only an entry is excluded here, not the book");
    assert.equal(status.indexed, 3);
    assert.equal(status.engineVectors, 1);
    assert.equal(status.failed, 0);
  } finally {
    await settleBackgroundIndexing();
    release();
  }
}

async function main() {
  pureStage1();
  await serverLane();
  console.log("lorebook-manager semantic regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
