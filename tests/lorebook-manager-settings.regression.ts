/**
 * Settings hub (A1): one global settings document, Compendiums that store only their overrides, a lazy migration of
 * pre-hub Compendiums, and the words-to-skip / strictness knobs for shared-word matching.
 */
import assert from "node:assert/strict";
import {
  bm25FloorFor,
  normalizeStopwordList,
  simulateLorebookRetrieval,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/retrieval.js";
import {
  DEFAULT_RECALL_SETTINGS,
  diffRecallSettings,
  normalizeCompendiumOverrides,
  normalizeRecallSettings,
  resolveRetrievalSettings,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/settings-helpers.js";
import type {
  LmEntryNode,
  LmGraphPayload,
  LmLiveRunRecord,
  LmRetrievalInput,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";
import {
  COMPENDIUM_DOC_KIND,
  CompendiumStoreError,
  LOREBOOK_MANAGER_PACKAGE_ID,
  createCompendium,
  getCompendium,
  listCompendiums,
  setChatCompendiumBinding,
  updateCompendium,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  refreshLiveClaims,
  resetLiveClaims,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import { contributeLiveLore } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import {
  getSettings,
  resetSettings,
  saveSettings,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/settings-store.js";

function makeMemoryDocStore(): LorebookManagerDocumentStore & { docs: Map<string, LorebookManagerDocumentRecord> } {
  const docs = new Map<string, LorebookManagerDocumentRecord>();
  return {
    docs,
    async list(packageId, kind) {
      return [...docs.values()].filter((d) => d.packageId === packageId && d.kind === kind).map((d) => ({ ...d }));
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

const message = (id: string, role: string, content: string): LorebookManagerMessageRecord => ({
  id,
  role,
  content,
  extra: "{}",
  createdAt: `2026-11-27T00:00:0${id}Z`,
});

function pureHelpers() {
  // Overrides keep only the fields given; everything else follows the defaults.
  const overrides = normalizeCompendiumOverrides({ recall: { tokenBudget: "4000", bogus: 1 }, archivist: {} });
  assert.deepEqual(overrides, { recall: { tokenBudget: 4000 } }, "only given fields, empty groups dropped");
  const defaults = normalizeRecallSettings({ ...DEFAULT_RECALL_SETTINGS, tokenBudget: 3000, maxTextHits: 8 });
  const resolved = resolveRetrievalSettings(defaults, overrides, { mha: 1200 });
  assert.equal(resolved.tokenBudget, 4000, "an override wins");
  assert.equal(resolved.maxTextHits, 8, "an absent field follows the default");
  assert.deepEqual(resolved.bookTokenBudgets, { mha: 1200 });
  assert.deepEqual(diffRecallSettings(defaults, { ...defaults, maxOneHop: 2 }), { maxOneHop: 2 });
  assert.deepEqual(diffRecallSettings(defaults, { ...defaults, extraStopwords: [] }), {}, "arrays compare by value");

  // Words to skip are cleaned the way BM25 reads words.
  assert.deepEqual(normalizeStopwordList(["Blue, fire", "  uchiha EYES ", "a", 7]), ["blue", "fire", "uchiha", "eyes"]);

  // Strictness moves the shared-word floor; a one-word query keeps a low fixed floor.
  for (const [count, top] of [
    [1, 3],
    [5, 6],
    [5, 20],
  ] as const) {
    const loose = bm25FloorFor(count, top, "loose");
    const normal = bm25FloorFor(count, top, "normal");
    const strict = bm25FloorFor(count, top, "strict");
    assert.ok(loose < normal && normal < strict, `loose < normal < strict for ${count} words, top ${top}`);
  }
  assert.equal(bm25FloorFor(5, 20), Math.max(4.0, 20 * 0.45), "normal is the floor from before the hub");
}

function sharedWordKnobs() {
  const payload = payloadOf([
    lore("susanoo", "Susanoo", { content: "Blue fire burns in the eyes of the Uchiha." }),
    lore("market", "Market", { content: "Spices and silk." }),
    lore("dock", "Dock", { content: "Ropes and tar." }),
    lore("forge", "Forge", { content: "Fire burns in the hearth, blue sparks." }),
    lore("garden", "Garden", { content: "Roses climb the wall." }),
    lore("tower", "Tower", { content: "Stone and wind." }),
    lore("road", "Road", { content: "Dust and mud." }),
    lore("well", "Well", { content: "Cold water, deep stone." }),
  ]);
  const input: LmRetrievalInput = {
    queryText: "Blue fire burns in the Uchiha eyes.",
    activeCharacterIds: [],
    tokenBudget: 4000,
    maxOneHop: 0,
    maxTextHits: 5,
  };
  const bm25 = (result: ReturnType<typeof simulateLorebookRetrieval>, ref: string) =>
    result.activated.find((item) => item.entry.ref === ref)?.reasons.find((reason) => reason.kind === "bm25");
  assert.ok(bm25(simulateLorebookRetrieval(payload, input), "lore:susanoo"), "shared words match by default");
  const skipped = simulateLorebookRetrieval(payload, {
    ...input,
    extraStopwords: ["Blue, fire", "burns uchiha eyes"],
  });
  assert.equal(bm25(skipped, "lore:susanoo"), undefined, "skipped words never count as shared");

  const hits = (strictness: "loose" | "normal" | "strict") =>
    simulateLorebookRetrieval(payload, { ...input, bm25Strictness: strictness }).activated.filter((item) =>
      item.reasons.some((reason) => reason.kind === "bm25"),
    ).length;
  assert.ok(hits("loose") >= hits("normal") && hits("normal") >= hits("strict"), "stricter never lets in more");
  // Forge shares three words but scores about half of Susanoo: in on Loose, out on Normal (probed 2026-11-27).
  assert.equal(hits("loose"), 2, "Loose lets the weaker Forge hit in");
  assert.equal(hits("normal"), 1, "Normal keeps only Susanoo");
}

async function storeAndLivePath() {
  const documents = makeMemoryDocStore();
  let messages: LorebookManagerMessageRecord[] = [];
  const books = [
    {
      id: "court",
      data: { name: "Fae Court", category: "world" },
      entries: [
        { id: "unseelie", name: "Unseelie Court", keys: ["Unseelie Court"], content: "The Unseelie Court rules." },
        { id: "syliveera", name: "Syliveera", keys: ["Syliveera"], content: "Syliveera greets the guest coldly." },
      ],
    },
  ];
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: {
      documents,
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return { id: chatId, name: "Fae night", characterIds: [], personaId: null };
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
  const release = configureLorebookManagerRuntime(runtime);
  try {
    // Settings: factory defaults until saved, groups merge, a stale revision is refused.
    const fresh = await getSettings(documents);
    assert.equal(fresh.revision, 0);
    assert.equal(fresh.recall.tokenBudget, DEFAULT_RECALL_SETTINGS.tokenBudget);
    assert.equal(fresh.archivist.mode, "off", "the Archivist starts off");
    const saved = await saveSettings(documents, { recall: { tokenBudget: 3000 }, expectedRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(saved.recall.tokenBudget, 3000);
    assert.equal(saved.recall.maxTextHits, DEFAULT_RECALL_SETTINGS.maxTextHits, "other fields stay");
    await assert.rejects(
      saveSettings(documents, { recall: { tokenBudget: 1 }, expectedRevision: 0 }),
      (error: unknown) => error instanceof CompendiumStoreError && error.statusCode === 409,
    );

    // Inheritance: a Compendium that sets nothing follows the defaults, one that sets a field keeps it.
    const plain = await createCompendium(documents, { name: "Plain", lorebookIds: ["court"] });
    const own = await createCompendium(documents, {
      name: "Own",
      lorebookIds: ["court"],
      overrides: { recall: { tokenBudget: 4000 } },
    });
    assert.deepEqual(plain.overrides, {});
    assert.equal(plain.retrievalSettings.tokenBudget, 3000);
    await saveSettings(documents, { recall: { tokenBudget: 2500 } });
    const [ownNow, plainNow] = await listCompendiums(documents);
    assert.equal(plainNow!.retrievalSettings.tokenBudget, 2500, "a default change reaches an inheriting Compendium");
    assert.equal(ownNow!.retrievalSettings.tokenBudget, 4000, "and not one that set its own");

    // A pre-hub client sends the whole resolved object on every save: only what it changed becomes an override.
    const legacySave = await updateCompendium(documents, plain.id, {
      name: "Plain renamed",
      retrievalSettings: { ...plainNow!.retrievalSettings, maxOneHop: 2 },
    });
    assert.deepEqual(legacySave.overrides, { recall: { maxOneHop: 2 } }, "a rename doesn't pin every field");
    await saveSettings(documents, { recall: { tokenBudget: 2200 } });
    assert.equal((await getCompendium(documents, plain.id))!.retrievalSettings.tokenBudget, 2200, "still inherits");
    // The overrides input replaces a group; null clears it.
    const cleared = await updateCompendium(documents, plain.id, { overrides: { recall: null } });
    assert.deepEqual(cleared.overrides, {});
    assert.equal(cleared.retrievalSettings.maxOneHop, DEFAULT_RECALL_SETTINGS.maxOneHop);
    const replaced = await updateCompendium(documents, own.id, { overrides: { recall: { maxTextHits: 9 } } });
    assert.deepEqual(replaced.overrides, { recall: { maxTextHits: 9 } }, "a given group replaces the stored one");
    // The old graph-regression shape (partial retrievalSettings) keeps the per-book budgets.
    const budgets = await updateCompendium(documents, own.id, {
      retrievalSettings: { bookTokenBudgets: { court: 900 } },
    });
    const merged = await updateCompendium(documents, own.id, { retrievalSettings: { maxTextHits: 3 } });
    assert.deepEqual(budgets.retrievalSettings.bookTokenBudgets, { court: 900 });
    assert.deepEqual(merged.retrievalSettings.bookTokenBudgets, { court: 900 }, "budgets survive an unrelated save");
    assert.equal(merged.retrievalSettings.maxTextHits, 3);

    // Migration: a Compendium saved before the hub holds a full retrievalSettings object.
    const now = new Date().toISOString();
    await documents.create({
      id: "compendium:legacy",
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: COMPENDIUM_DOC_KIND,
      name: "Legacy",
      description: "",
      data: {
        lorebookIds: ["court"],
        characterIds: [],
        personaIds: [],
        worldMapId: null,
        retrievalSettings: {
          tokenBudget: 2000,
          queryMessageCount: 2,
          maxOneHop: 6,
          maxTextHits: 9,
          respectBookBudgets: true,
          bookTokenBudgets: { court: 500 },
          semanticEnabled: true,
          semanticThreshold: 0.15,
          stage2Gate: "decision",
          librarianConnectionId: null,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const legacy = (await getCompendium(documents, "compendium:legacy"))!;
    assert.deepEqual(
      legacy.overrides,
      { recall: { maxTextHits: 9, semanticEnabled: true, stage2Gate: "decision" } },
      "only the values that differ from the pre-hub defaults become overrides",
    );
    assert.equal(legacy.retrievalSettings.tokenBudget, 2200, "an unchanged pre-hub value follows today's default");
    assert.deepEqual(legacy.retrievalSettings.bookTokenBudgets, { court: 500 });
    await updateCompendium(documents, legacy.id, { name: "Legacy saved" });
    const written = documents.docs.get("compendium:legacy")!.data as Record<string, unknown>;
    assert.equal(written.retrievalSettings, undefined, "the next save writes the new shape");
    assert.deepEqual(written.overrides, legacy.overrides);
    assert.deepEqual(written.bookTokenBudgets, { court: 500 });

    // The live path reads the resolved settings: a default change reaches the turn after the claims refresh.
    const window = [
      message("1", "user", "Syliveera waits."),
      message("2", "assistant", "We walk on."),
      message("3", "user", "We reach the Unseelie Court."),
    ];
    messages = window;
    await setChatCompendiumBinding(documents, "chat-1", plain.id);
    await saveSettings(documents, { recall: { queryMessageCount: 3 } });
    await refreshLiveClaims();
    const added = { enableAgents: true, activeAgentIds: ["lorebook-manager"] };
    const request = { chatId: "chat-1", chatMeta: added, mode: "roleplay", wrapFormat: "xml" as const };
    const wide = await contributeLiveLore(request);
    assert.match(wide!, /Syliveera greets/, "3 messages to match, from the defaults");
    await updateCompendium(documents, plain.id, { overrides: { recall: { queryMessageCount: 2 } } });
    await refreshLiveClaims();
    const narrow = await contributeLiveLore(request);
    assert.doesNotMatch(narrow!, /Syliveera greets/, "the Compendium's own 2 wins");
    const runs = (documents.docs.get("live_run:chat-1")?.data as { runs: LmLiveRunRecord[] }).runs;
    assert.deepEqual(
      runs.map((run) => run.queryMessageCount),
      [2, 3],
    );

    // Reset: factory defaults again; Compendium overrides stay.
    const reset = await resetSettings(documents);
    assert.equal(reset.recall.tokenBudget, DEFAULT_RECALL_SETTINGS.tokenBudget);
    assert.equal(reset.recall.queryMessageCount, DEFAULT_RECALL_SETTINGS.queryMessageCount);
    assert.deepEqual((await getCompendium(documents, plain.id))!.overrides, { recall: { queryMessageCount: 2 } });
  } finally {
    resetLiveClaims();
    release();
  }
}

async function main() {
  pureHelpers();
  sharedWordKnobs();
  await storeAndLivePath();
}

main()
  .then(() => console.log("lorebook-manager-settings.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
