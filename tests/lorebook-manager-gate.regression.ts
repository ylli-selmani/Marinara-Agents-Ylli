/**
 * Slice 3c-2: the Stage 2 gate. Only meaning-only picks are checked, by the Decision model or the Librarian, at most
 * one call, and the gate fails open: whatever goes wrong, the entry stays. Fakes copy the real host shapes
 * (`CapabilityDecisionResult`, `CapabilityLanguageModelCompletion`), the 3a lesson.
 */
import assert from "node:assert/strict";
import type {
  LmEntryNode,
  LmRetrievalActivatedItem,
  LmRetrievalResult,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/schema.js";
import { normalizeCompendiumRetrievalSettings } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/compendium-helpers.js";
import {
  createCompendium,
  setChatCompendiumBinding,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import { refreshLiveClaims } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import { contributeLiveLore } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDecisionHost,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerLanguageModelHost,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import {
  resetSemanticIndexState,
  settleBackgroundIndexing,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/semantic-index.js";
import {
  GATE_MAX_DECISION_QUESTIONS,
  gateCandidates,
  resetGateVerdicts,
  runStage2Gate,
  type GateContext,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/stage2-gate.js";

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

function entry(id: string, name: string, description = ""): LmEntryNode {
  return {
    nodeType: "lore",
    ref: `lore:${id}`,
    id,
    lorebookId: "book",
    lorebookName: "Book",
    lorebookCategory: "world",
    name,
    description,
    content: `${name} content.`,
    keys: [name.toLowerCase()],
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
  } as LmEntryNode;
}

function item(id: string, name: string, kinds: string[], tokens = 10): LmRetrievalActivatedItem {
  return {
    entry: entry(id, name, `${name} summary`),
    tokens,
    score: 1,
    tier: "direct",
    reasons: kinds.map((kind) => ({ kind, detail: kind })) as LmRetrievalActivatedItem["reasons"],
    viaRefs: [],
  };
}

function stage1(items: LmRetrievalActivatedItem[]): LmRetrievalResult {
  return {
    activated: items,
    suppressed: [],
    totalTokens: items.reduce((sum, row) => sum + row.tokens, 0),
    tokenBudget: 2000,
    durationMs: 1,
    cardInheritedSeedRefs: [],
  };
}

const context = (overrides: Partial<GateContext> = {}): GateContext => ({
  chatId: "chat",
  mode: "roleplay",
  queryMessages: [
    { role: "user", content: "We walk to the harbor." },
    { role: "assistant", content: "Gulls cry over the boats." },
  ],
  chatConnectionId: "chat-conn",
  startedAt: Date.now(),
  ...overrides,
});

const decision = { stage2Gate: "decision" as const, librarianConnectionId: null };
const librarian = { stage2Gate: "librarian" as const, librarianConnectionId: "lib-conn" };

function baseRuntime(extra: Partial<LorebookManagerRuntimeHost> = {}): LorebookManagerRuntimeHost {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: { documents: makeMemoryDocStore() },
    resources: {
      async listLorebooks() {
        return [];
      },
      async listCharacters() {
        return [];
      },
      async listPersonas() {
        return [];
      },
    },
    ...extra,
  };
}

async function unitCases() {
  // Settings: off by default, unknown values fall back, the connection is trimmed.
  const defaults = normalizeCompendiumRetrievalSettings({});
  assert.equal(defaults.stage2Gate, "instant");
  assert.equal(defaults.librarianConnectionId, null);
  assert.equal(normalizeCompendiumRetrievalSettings({ stage2Gate: "oracle" }).stage2Gate, "instant");
  assert.equal(normalizeCompendiumRetrievalSettings({ librarianConnectionId: "  c1 " }).librarianConnectionId, "c1");

  const mixed = stage1([
    item("oath", "Oath", ["constant"]),
    item("harbor", "Harbor", ["keyword"]),
    item("gull", "Gull", ["semantic"]),
    item("boat", "Boat", ["semantic", "bm25"]),
    item("kraken", "Kraken", ["semantic"], 40),
  ]);
  assert.deepEqual(
    gateCandidates(mixed).map((row) => row.entry.ref),
    ["lore:gull", "lore:kraken"],
    "only entries found by meaning alone are checked",
  );

  // Instant never asks anything.
  const instant = await runStage2Gate({ stage2Gate: "instant", librarianConnectionId: null }, mixed, context());
  assert.equal(instant.info, null);
  assert.equal(instant.result, mixed);

  // Decision: the model's own threshold decides; a missing answer keeps the entry; tokens are recomputed.
  resetGateVerdicts();
  const asked: Array<Parameters<LorebookManagerDecisionHost["evaluate"]>[0]> = [];
  let release = configureLorebookManagerRuntime(
    baseRuntime({
      decisions: {
        async evaluate(request) {
          asked.push(request);
          // e1 = Gull (yes), e2 = Kraken (no). Threshold 0.6, as a calibrated model might report.
          return { model: "noul-small", answers: { e1: 0.9, e2: 0.2 }, choices: {}, threshold: 0.6 };
        },
      },
    }),
  );
  try {
    const out = await runStage2Gate(decision, mixed, context());
    assert.equal(out.info?.status, "used");
    assert.equal(out.info?.checked, 2);
    assert.deepEqual(out.info?.dropped, [{ ref: "lore:kraken", name: "Kraken" }]);
    assert.equal(out.info?.model, "noul-small");
    assert.deepEqual(
      out.result.activated.map((row) => row.entry.name),
      ["Oath", "Harbor", "Gull", "Boat"],
    );
    assert.equal(out.result.totalTokens, 40, "Kraken's 40 tokens are gone from the total");
    assert.equal(asked.length, 1, "one batched call");
    assert.deepEqual(
      asked[0]!.questions.map((q) => q.id),
      ["e1", "e2"],
    );
    assert.ok(asked[0]!.questions.every((q) => q.question.length <= 500));
    assert.deepEqual(
      asked[0]!.messages.map((m) => m.role),
      ["user", "assistant"],
      "the scene keeps its roles",
    );

    // Same chat, same messages, same candidates (Peek, then the turn, then a swipe): the cached verdict, no call.
    const again = await runStage2Gate(decision, mixed, context());
    assert.equal(again.info?.status, "cached");
    assert.deepEqual(
      again.info?.dropped.map((row) => row.name),
      ["Kraken"],
    );
    assert.equal(asked.length, 1, "no second call");
    // New messages ask again.
    await runStage2Gate(decision, mixed, context({ queryMessages: [{ role: "user", content: "Something else." }] }));
    assert.equal(asked.length, 2);

    // More candidates than the cap: the first 16 are asked, the rest stay unchecked.
    resetGateVerdicts();
    const many = stage1(Array.from({ length: 20 }, (_v, i) => item(`m${i}`, `M${i}`, ["semantic"])));
    await runStage2Gate(decision, many, context());
    assert.equal(asked.at(-1)!.questions.length, GATE_MAX_DECISION_QUESTIONS);
  } finally {
    release();
  }

  // Decision model not set up (host answers null), or an Engine without the host: keep everything.
  resetGateVerdicts();
  release = configureLorebookManagerRuntime(baseRuntime({ decisions: { evaluate: async () => null } }));
  try {
    const out = await runStage2Gate(decision, mixed, context());
    assert.equal(out.info?.status, "unavailable");
    assert.equal(out.result.activated.length, 5);
  } finally {
    release();
  }
  release = configureLorebookManagerRuntime(baseRuntime());
  try {
    assert.equal((await runStage2Gate(decision, mixed, context())).info?.status, "unavailable");
    // Nothing meaning-only: nothing to ask, and no host needed.
    const plain = stage1([item("harbor", "Harbor", ["keyword"])]);
    assert.equal((await runStage2Gate(decision, plain, context())).info?.status, "nothing_to_check");
  } finally {
    release();
  }

  // A throwing host is an error, kept all; a hanging one times out inside the gate's own deadline.
  resetGateVerdicts();
  let seenSignal: AbortSignal | undefined;
  release = configureLorebookManagerRuntime(
    baseRuntime({
      decisions: {
        async evaluate(request) {
          if (request.messages[0]?.content === "boom") throw new Error("limit exceeded");
          seenSignal = request.signal;
          return new Promise(() => {});
        },
      },
    }),
  );
  try {
    const failed = await runStage2Gate(
      decision,
      mixed,
      context({ queryMessages: [{ role: "user", content: "boom" }] }),
    );
    assert.equal(failed.info?.status, "error");
    assert.match(failed.info?.detail ?? "", /limit exceeded/u);
    assert.equal(failed.result.activated.length, 5);
    // 4 s already spent: 4.5 s - 4 s = 0.5 s left for the gate.
    const before = Date.now();
    const slow = await runStage2Gate(decision, mixed, context({ startedAt: Date.now() - 4_000 }));
    assert.equal(slow.info?.status, "timeout");
    assert.ok(Date.now() - before < 1_500, "the gate's deadline, not the Engine's 5 s");
    assert.equal(seenSignal?.aborted, true, "the host call is aborted");
    assert.equal(slow.result.activated.length, 5);
    // 4.3 s spent: too little left to ask at all.
    const late = await runStage2Gate(decision, mixed, context({ startedAt: Date.now() - 4_300, chatId: "late" }));
    assert.equal(late.info?.status, "skipped");
  } finally {
    release();
  }

  // Librarian: one completion over compact rows; only listed ids count; the Compendium's connection, then the chat's.
  resetGateVerdicts();
  const resolved: Array<Parameters<LorebookManagerLanguageModelHost["resolveForRequest"]>[0]> = [];
  const prompts: string[] = [];
  let reply: string | null = '{"keep": ["e1", "e9"]}';
  release = configureLorebookManagerRuntime(
    baseRuntime({
      languageModels: {
        async resolveForRequest(request) {
          resolved.push(request);
          return {
            connectionId: request.connectionId ?? "agents-default",
            model: "tiny-librarian",
            async chatComplete(messages, options) {
              prompts.push(messages.map((m) => m.content).join("\n"));
              assert.equal(options?.temperature, 0);
              assert.ok(options?.signal instanceof AbortSignal);
              return { content: reply, finishReason: "stop" };
            },
          };
        },
      },
      json: { parseJsonish: (raw) => JSON.parse(raw) },
    }),
  );
  try {
    const out = await runStage2Gate(librarian, mixed, context());
    assert.equal(out.info?.status, "used");
    assert.equal(out.info?.mode, "librarian");
    assert.deepEqual(
      out.info?.dropped.map((row) => row.name),
      ["Kraken"],
      "e9 names nothing; Kraken (e2) not kept",
    );
    assert.deepEqual(resolved[0], { connectionId: "lib-conn", chatConnectionId: "chat-conn" });
    assert.match(prompts[0]!, /e1 \| Gull \| lore \| gull \| Gull summary/u);
    assert.doesNotMatch(prompts[0]!, /Harbor \|/u, "trusted hits are not sent");
    assert.match(prompts[0]!, /Gulls cry over the boats\./u, "the scene is sent");

    reply = "I think they are all fine!";
    const unreadable = await runStage2Gate(librarian, mixed, context({ chatId: "other" }));
    assert.equal(unreadable.info?.status, "error");
    assert.equal(unreadable.result.activated.length, 5, "an unreadable reply drops nothing");
  } finally {
    release();
  }
}

// ── Live: a Compendium with a Decision gate drops a meaning-only pick, and the run says so. ──

const CONCEPTS: Array<RegExp> = [/storm|tempest|gale/u, /sea|wave|water|ocean/u, /ship|sail|boat/u, /fire|flame/u];
const conceptVector = (text: string) => {
  const words = text.toLowerCase().match(/[a-z]+/gu) ?? [];
  return CONCEPTS.map((pattern) => words.filter((word) => pattern.test(word)).length);
};

async function liveCase() {
  resetGateVerdicts();
  resetSemanticIndexState();
  const documents = makeMemoryDocStore();
  const books = [
    {
      id: "coast",
      data: { name: "Coast", category: "world" },
      entries: [
        { id: "gale", name: "Gale Sea", content: "Gales churn the grey ocean." },
        { id: "anchor", name: "Anchor", keys: ["anchor"], content: "The anchor holds." },
      ] as Array<Record<string, unknown>>,
    },
  ];
  let messages: LorebookManagerMessageRecord[] = [];
  let decisionCalls = 0;
  let verdict = 0.1;
  const runtime: LorebookManagerRuntimeHost = {
    ...baseRuntime(),
    async resolveEmbeddings() {
      return {
        spaceId: "remote:test",
        label: "Test",
        async embed(texts) {
          return texts.map(conceptVector);
        },
      };
    },
    decisions: {
      async evaluate() {
        decisionCalls++;
        return { model: "noul-small", answers: { e1: verdict }, choices: {}, threshold: 0.5 };
      },
    },
    persistence: {
      documents,
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return { id: chatId, name: "Sea", characterIds: [], personaId: null, connectionId: null };
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
    const compendium = await createCompendium(documents, {
      name: "Coast",
      lorebookIds: ["coast"],
      retrievalSettings: { semanticEnabled: true, queryMessageCount: 1, stage2Gate: "decision" },
    });
    assert.equal(compendium.retrievalSettings.stage2Gate, "decision");
    await setChatCompendiumBinding(documents, "sea", compendium.id);
    await refreshLiveClaims();
    const request = {
      chatId: "sea",
      chatMeta: { enableAgents: true, activeAgentIds: ["lorebook-manager"] },
      mode: "roleplay",
      wrapFormat: "none" as const,
    };
    messages = [
      {
        id: "1",
        role: "user",
        content: "A tempest rises over the waves, drop the anchor.",
        extra: "{}",
        createdAt: "2026-11-26T00:00:01Z",
      },
    ];
    // The first turn may lack vectors (they index in the background); settle, then run the turn that counts.
    await contributeLiveLore({ ...request, preview: true });
    await settleBackgroundIndexing();
    resetGateVerdicts();
    decisionCalls = 0;

    // Peek first: it asks once and records nothing.
    const peek = await contributeLiveLore({ ...request, preview: true });
    assert.doesNotMatch(peek ?? "", /Gales churn/u, "the Decision model turned the meaning-only pick down");
    assert.match(peek ?? "", /The anchor holds\./u, "a keyword hit is never checked");
    assert.equal(decisionCalls, 1);
    // The real turn reuses Peek's verdict, so Peek showed exactly what is sent.
    const lore = await contributeLiveLore(request);
    assert.equal(lore, peek);
    assert.equal(decisionCalls, 1, "no second call for the same scene");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = (documents.docs.get("live_run:sea")?.data as { runs?: Array<Record<string, any>> })?.runs?.[0];
    assert.equal(run?.gate?.mode, "decision");
    assert.equal(run?.gate?.status, "cached");
    assert.deepEqual(run?.gate?.dropped, [{ ref: "lore:gale", name: "Gale Sea" }]);
    assert.equal(typeof run?.totalMs, "number");
    assert.ok(run!.totalMs >= run!.durationMs - 1, "the whole turn includes Stage 1");
    assert.ok(!run?.activated.some((row: { ref: string }) => row.ref === "lore:gale"));

    // A yes keeps it.
    verdict = 0.9;
    messages = [
      {
        id: "2",
        role: "user",
        content: "The tempest grows over the waves.",
        extra: "{}",
        createdAt: "2026-11-26T00:00:02Z",
      },
    ];
    assert.match((await contributeLiveLore(request)) ?? "", /Gales churn/u);
  } finally {
    await settleBackgroundIndexing();
    release();
  }
}

async function main() {
  await unitCases();
  await liveCase();
  console.log("lorebook-manager gate regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
