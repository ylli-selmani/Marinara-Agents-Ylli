import {
  applyFieldEdits,
  createSheetContent,
  foldFieldEdits,
  normalizeFieldEdits,
  parseSheetLines,
  sheetFieldEdits,
  sheetFields,
  sheetFamily,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/sheets.js";
import { composePrompt } from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/prompts.js";
/**
 * B1a: the Archivist. Lookup-then-Diff over settled messages past the watermark, one model call, suggestions into
 * Review. A fake model host answers in the Engine's real shapes; no model is called for real.
 * Run: npx tsx --tsconfig tests/tsconfig.regressions.json tests/lorebook-manager-archivist.regression.ts
 */
import assert from "node:assert/strict";
import {
  ARCHIVIST_SYSTEM,
  getArchivistBackfillStatus,
  startArchivistBackfill,
  stopArchivistBackfill,
  runInBackgroundQueue,
  armArchivist,
  isArchivistArmed,
  listArchivistRuns,
  resumeArchivist,
  runArchivist,
  sameName,
  stopArchivist,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/archivist.js";
import {
  createCompendium,
  setChatCompendiumBinding,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  refreshLiveClaims,
  resetLiveClaims,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import { contributeLiveLore } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  applyProposal,
  appendProposalFieldEdits,
  narrowPatch,
  createProposal,
  dismissProposal,
  listProposals,
  mergeNewFacts,
  novelFacts,
  undoProposal,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/proposals-store.js";
import {
  crawlAfterArchivist,
  listCrawlerRuns,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/crawler.js";
import { lorebookManagerRoutes } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/routes.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import { activate } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/server-entry.js";
import { saveSettings } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/settings-store.js";

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

// Messages in the Engine's shape (capability-persistence `mapMessage`): activeSwipeIndex, extra as a JSON string.
let clock = 0;
const message = (id: string, role: string, content: string, swipe = 0): LorebookManagerMessageRecord => ({
  id,
  role,
  content,
  extra: "{}",
  activeSwipeIndex: swipe,
  createdAt: new Date(Date.UTC(2026, 10, 26, 0, 0, clock++)).toISOString(),
});

const books = [
  {
    id: "court",
    data: { name: "Fae Court", category: "world" },
    entries: [
      {
        id: "unseelie",
        name: "Unseelie Court",
        keys: ["Unseelie Court"],
        content: "The Unseelie Court rules the night.",
      },
      {
        id: "syliveera",
        name: "Syliveera",
        keys: ["Syliveera"],
        content: "Syliveera greets {{user}} coldly.\nRank: Genin\nRole: Envoy",
        tag: "character",
      },
      { id: "gate", name: "Thorn Gate", keys: ["Thorn Gate"], locked: true, content: "The Thorn Gate never opens." },
      {
        id: "directory-only",
        name: "Forgotten Lighthouse",
        keys: ["Forgotten Lighthouse"],
        content: "A distant lighthouse.",
      },
    ] as Array<Record<string, unknown>>,
  },
  { id: "cast", data: { name: "Cast", category: "character" }, entries: [] as Array<Record<string, unknown>> },
];

// The chat's metadata arrives as a JSON string from the host (capability-persistence `mapChat`).
const ADDED = JSON.stringify({ enableAgents: true, activeAgentIds: ["lorebook-manager"] });

type Answer = (prompt: string) => string | Error | Promise<string | Error>;

async function main() {
  // Pure helpers first.
  assert.ok(sameName("Kakashi", "Kakashi Hatake"));
  assert.ok(sameName("Unseelie Court", "unseelie court"));
  assert.ok(!sameName("Ash", "Ashen Vale"), "short names need whole words");
  assert.ok(!sameName("Konoha", "Konohagakure"), "no substring guesses");
  assert.deepEqual(novelFacts("Syliveera greets {{user}} coldly.", ["Syliveera greets {{user}} coldly", "New."]), [
    "New.",
  ]);
  assert.equal(mergeNewFacts("A.", ["B.", "A", "C."]), "A.\n\nB. C.");

  assert.equal(sheetFamily("event"), "quest");
  assert.equal(sheetFamily("concept"), "lore");
  assert.equal(sheetFamily("something else"), "lore");
  assert.deepEqual(sheetFields("lore", { lore: ["Never"] }), []);
  assert.equal(
    createSheetContent(sheetFields("character"), [
      { field: "Status", value: "Alive" },
      { field: "Role", value: "Scout" },
    ]),
    "Role: Scout\nStatus: Alive",
  );
  assert.deepEqual(
    sheetFieldEdits("x".repeat(1600) + "\nRank: Genin", ["Rank"], [{ field: "rank", value: "Rank: Chūnin\nnow" }]),
    [{ field: "Rank", from: "Genin", to: "Chūnin now" }],
  );
  assert.deepEqual(sheetFieldEdits("Rank: Genin", ["Rank"], [{ field: "Rank", value: "Genin" }]), []);
  assert.equal(applyFieldEdits("Old prose.", [{ field: "Role", from: null, to: "Scout" }]), "Old prose.\nRole: Scout");
  assert.equal(
    applyFieldEdits("A+B: old\r\nA+B: untouched\r\nTail", [{ field: "A+B", from: "old", to: "A+B: new\nvalue" }]),
    "A+B: new value\r\nA+B: untouched\r\nTail",
  );
  assert.deepEqual(parseSheetLines('https://example.org\n12:30\nShe "said": no\n**Role:** bold\nRole: Scout'), [
    { field: "Role", value: "Scout" },
  ]);
  assert.deepEqual(
    normalizeFieldEdits([
      { field: "https://bad", from: null, to: "bad" },
      { field: "Role", from: 5, to: "bad" },
    ]),
    [],
  );
  assert.deepEqual(
    foldFieldEdits([{ field: "Rank", from: "Genin", to: "Chūnin" }], [{ field: "rank", from: "Chūnin", to: "Genin" }]),
    [],
  );
  assert.deepEqual(
    narrowPatch(
      { fieldEdits: [{ field: "Rank", from: "Genin", to: "Chūnin" }] },
      {
        fieldEdits: [
          { field: "rank", from: "invented", to: "Jōnin" },
          { field: "Owner", from: null, to: "No" },
        ],
      },
    ),
    { fieldEdits: [{ field: "Rank", from: "Genin", to: "Jōnin" }] },
  );

  const documents = makeMemoryDocStore();
  let messages: LorebookManagerMessageRecord[] = [];
  let metadata: unknown = ADDED;
  const modelCalls: Array<{ request: unknown; prompt: string; system: string }> = [];
  let answer: Answer = () => '{"updates": [], "creates": []}';
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: {
      documents,
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return {
          id: chatId,
          name: "Fae night",
          characterIds: [],
          personaId: null,
          connectionId: "conn-chat",
          metadata,
        };
      },
    },
    languageModels: {
      async resolveForRequest(request) {
        return {
          connectionId: request.connectionId ?? request.chatConnectionId ?? "default",
          model: "fake-model",
          async chatComplete(chat) {
            const system = chat.find((m) => m.role === "system")?.content ?? "";
            const prompt = chat.find((m) => m.role === "user")?.content ?? "";
            modelCalls.push({ request, prompt, system });
            const reply = await answer(prompt);
            if (reply instanceof Error) throw reply;
            return { content: reply, finishReason: "stop" };
          },
        };
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
      async createLorebookEntry(lorebookId, entry) {
        const id = `new-${lorebookId}-${String(entry.name)}`;
        books.find((book) => book.id === lorebookId)!.entries.push({ ...entry, id });
        return { id, lorebookId, data: { ...entry, id } };
      },
      async updateLorebookEntry(entryId, patch) {
        const entry = books.flatMap((book) => book.entries).find((e) => e.id === entryId);
        if (!entry) return null;
        if (entry.locked === true) throw new Error("This entry is locked");
        Object.assign(entry, patch);
        return { id: entryId, lorebookId: "court", data: entry };
      },
      async removeLorebookEntry(entryId) {
        for (const book of books) book.entries = book.entries.filter((entry) => entry.id !== entryId);
      },
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  /** The short id the prompt gave an entry ("[c2] Syliveera" → c2). */
  const shortId = (prompt: string, name: string) => new RegExp(`\\[(c\\d+)\\] ${name} `).exec(prompt)?.[1] ?? "c?";
  try {
    const compendium = await createCompendium(documents, { name: "Fae", lorebookIds: ["court", "cast"] });
    await setChatCompendiumBinding(documents, "chat-1", compendium.id);
    await refreshLiveClaims();
    await saveSettings(documents, {
      archivist: { mode: "suggest", everyNTurns: 2, readBehind: 1 },
      sheets: { character: ["Rank", "Role", "Affiliation", "Currently"] },
    });

    // ── Not due: two messages are left unread, so only one reply is settled. ──
    messages = [
      message("u1", "user", "We enter the Unseelie Court."),
      message("a2", "assistant", "Syliveera bows; she now serves the Seelie Queen."),
      message("u3", "user", "I ask about the Thorn Gate."),
      message("a4", "assistant", "Brannoc the Smith forged the Thorn Gate's lock.", 2),
    ];
    assert.equal((await runArchivist("chat-1")).status, "not_due");
    assert.equal(modelCalls.length, 0, "no model call before N replies are settled");

    // ── The newest message is the user's: the reply is still being written. ──
    messages = [...messages, message("u5", "user", "And then?")];
    assert.equal((await runArchivist("chat-1")).status, "reply_pending");

    // ── Due: Read Behind 1 leaves the newest reply (a6) unread; u1..u5 are settled. ──
    messages = [...messages, message("a6", "assistant", "The night deepens.")];
    answer = (prompt) =>
      JSON.stringify({
        updates: [
          {
            id: shortId(prompt, "Syliveera"),
            fields: [
              { field: "Rank", value: "Chūnin" },
              { field: "Role", value: "Envoy" },
              { field: "Bogus", value: "drop" },
              { field: "Affiliation", value: " " },
            ],
          },
          { id: shortId(prompt, "Thorn Gate"), fields: [{ field: "Status", value: "Sealed" }] },
          { id: "d1", fields: [{ field: "Role", value: "Unseen" }] },
          { id: "c99", fields: [{ field: "Status", value: "Nothing" }] },
        ],
        creates: [
          {
            name: "Brannoc the Smith",
            category: "character",
            fields: [
              { field: "Affiliation", value: "Court" },
              { field: "Role", value: "Fae smith" },
              { field: "Bogus", value: "drop" },
            ],
            keys: [],
          },
          {
            name: "unseelie court",
            category: "faction",
            fields: [{ field: "Type", value: "Court of the night" }],
            keys: ["Night Court"],
          },
        ],
      });
    const done = await runArchivist("chat-1");
    assert.equal(done.status, "done", JSON.stringify(done.run));
    assert.equal(modelCalls.length, 1);
    const call = modelCalls[0]!;
    assert.equal(call.system, ARCHIVIST_SYSTEM);
    assert.deepEqual(
      call.request,
      { connectionId: null, chatConnectionId: "conn-chat" },
      "Archivist connection, then the chat's",
    );
    assert.ok(call.prompt.includes("Brannoc the Smith forged"), "settled messages are read");
    assert.match(call.prompt, /d1 \| Forgotten Lighthouse/);
    assert.ok(!call.prompt.includes("The night deepens"), "the unread reply is not");
    assert.ok(
      /\[c\d+\] Syliveera /.test(call.prompt) && /\[c\d+\] Thorn Gate /.test(call.prompt),
      "looked-up entries in full",
    );

    const pending = await listProposals(documents, "pending");
    const update = pending.find((p) => p.kind === "update_entry")!;
    assert.equal(update.targetEntryId, "syliveera");
    assert.deepEqual(
      update.patch,
      { fieldEdits: [{ field: "Rank", from: "Genin", to: "Chūnin" }] },
      "same-value, empty and unknown fields dropped",
    );
    assert.equal(call.system, composePrompt("archivist"));
    assert.match(call.prompt, /<sheets>[\s\S]*character sheet: Rank, Role, Affiliation, Currently/);
    assert.match(
      call.prompt,
      new RegExp(`${shortId(call.prompt, "Syliveera")} sheet: Rank, Role, Affiliation, Currently`),
    );
    assert.deepEqual(
      update.sourceMessageRefs.map((ref) => `${ref.messageId}:${ref.swipeIndex}`),
      ["u1:0", "a2:0", "u3:0", "a4:2", "u5:0"],
      "sources carry the visible swipe",
    );
    const brannoc = pending.find((p) => p.entryName === "Brannoc the Smith")!;
    assert.equal(brannoc.lorebookId, "cast", "a character lands in the character book");
    assert.deepEqual(brannoc.patch, {
      content: "Role: Fae smith\nAffiliation: Court",
      keys: ["Brannoc the Smith"],
      tag: "character",
    });
    assert.equal(brannoc.duplicateOfEntryId, null);
    const dup = pending.find((p) => p.entryName === "unseelie court")!;
    assert.equal(dup.duplicateOfEntryId, "unseelie", "a create named like an entry is flagged, still in Review");
    assert.equal(dup.lorebookId, "court");
    assert.equal(pending.length, 3, "the locked entry and the unknown id made nothing");
    const run = done.run!;
    assert.deepEqual(
      run.skipped.map((s) => s.why).sort(),
      ["locked", "unknown entry", "unknown entry"],
      JSON.stringify(run.skipped),
    );
    assert.equal(run.updates, 1);
    assert.equal(run.creates, 2);

    // ── Nothing new since: no model call. ──
    assert.equal((await runArchivist("chat-1")).status, "nothing_new");
    assert.equal(modelCalls.length, 1);

    // ── Next window: a new fact for Syliveera folds into her pending update; Brannoc isn't suggested twice. ──
    messages = [
      ...messages,
      message("u7", "user", "Syliveera draws a knife."),
      message("a8", "assistant", "She keeps a silver knife."),
      message("u9", "user", "Hm."),
      message("a10", "assistant", "Silence."),
    ];
    answer = (prompt) =>
      JSON.stringify({
        updates: [
          {
            id: shortId(prompt, "Syliveera"),
            fields: [
              { field: "rank", value: "Jōnin" },
              { field: "Currently", value: "Carries a silver knife" },
            ],
          },
        ],
        creates: [
          { name: "Brannoc the Smith", category: "character", fields: [{ field: "Role", value: "Smith" }], keys: [] },
        ],
      });
    const second = await runArchivist("chat-1");
    assert.equal(second.status, "done");
    assert.ok(modelCalls[1]!.prompt.includes("The night deepens"), "the window starts after the watermark");
    assert.ok(!modelCalls[1]!.prompt.includes("Brannoc the Smith forged"), "...and not before it");
    const afterSecond = await listProposals(documents, "pending");
    assert.equal(afterSecond.length, 3, "folded, not a fourth suggestion");
    const folded = afterSecond.find((p) => p.id === update.id)!;
    assert.deepEqual(folded.patch.fieldEdits, [
      { field: "Rank", from: "Genin", to: "Jōnin" },
      { field: "Currently", from: null, to: "Carries a silver knife" },
    ]);
    assert.ok(folded.sourceMessageRefs.some((ref) => ref.messageId === "a8"));
    assert.deepEqual(second.run!.skipped, [{ name: "Brannoc the Smith", why: "already suggested" }]);

    // ── Apply merges the facts into the entry as it is now; a dismissed create is never suggested again. ──
    books[0]!.entries[1]!.content = "Syliveera greets {{user}} coldly. She hates iron.\r\nRank: Genin";
    const applied = await applyProposal(runtime, update.id);
    assert.equal(
      books[0]!.entries[1]!.content,
      "Syliveera greets {{user}} coldly. She hates iron.\r\nRank: Jōnin\r\nCurrently: Carries a silver knife",
    );
    assert.deepEqual(
      applied.before,
      { content: "Syliveera greets {{user}} coldly. She hates iron.\r\nRank: Genin" },
      "before for Undo",
    );
    await dismissProposal(documents, brannoc.id);
    messages = [
      ...messages,
      message("u11", "user", "x"),
      message("a12", "assistant", "y"),
      message("u13", "user", "z"),
      message("a14", "assistant", "w"),
    ];
    answer = () =>
      JSON.stringify({
        updates: [],
        creates: [
          { name: "Brannoc the Smith", category: "character", fields: [{ field: "Role", value: "Smith" }], keys: [] },
        ],
      });
    const third = await runArchivist("chat-1");
    assert.deepEqual(third.run!.skipped, [{ name: "Brannoc the Smith", why: "dismissed before" }]);

    // ── A failing model: the watermark stays, auto runs cool down, Run now still goes. ──
    messages = [
      ...messages,
      message("u15", "user", "a"),
      message("a16", "assistant", "b"),
      message("u17", "user", "c"),
      message("a18", "assistant", "d"),
    ];
    answer = () => new Error("Provider is down");
    const failed = await runArchivist("chat-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.run!.detail, "Provider is down");
    assert.equal((await runArchivist("chat-1")).status, "cooling_down");
    answer = () => "I think nothing happened.";
    assert.equal((await runArchivist("chat-1", { force: true })).run!.detail, "The model's answer wasn't readable");
    answer = () => '{"updates": [], "creates": []}';
    const forced = await runArchivist("chat-1", { force: true });
    assert.equal(forced.status, "done");
    assert.ok(modelCalls.at(-1)!.prompt.includes("Player: a"), "the failed window was read again");
    assert.equal(
      (await runArchivist("chat-1", { force: true })).status,
      "nothing_new",
      "Run now records why nothing ran",
    );

    // ── Removed from the chat or off: auto runs stop; Run now still works. ──
    metadata = JSON.stringify({ enableAgents: true, activeAgentIds: [] });
    messages = [
      ...messages,
      message("u19", "user", "e"),
      message("a20", "assistant", "f"),
      message("u21", "user", "g"),
      message("a22", "assistant", "h"),
    ];
    assert.equal((await runArchivist("chat-1")).status, "off");
    metadata = ADDED;
    await saveSettings(documents, { archivist: { mode: "off" } });
    assert.equal((await runArchivist("chat-1")).status, "off");
    const runs = await listArchivistRuns();
    assert.ok(runs.length >= 5 && runs[0]!.trigger === "manual", "runs recorded, newest first");

    // ── A long chat: the first run reads the newest window; later runs read oldest first and skip nothing. ──
    await saveSettings(documents, { archivist: { mode: "suggest", everyNTurns: 1, readBehind: 1 } });
    await setChatCompendiumBinding(documents, "chat-long", compendium.id);
    await refreshLiveClaims();
    answer = () => '{"updates": [], "creates": []}';
    const lines = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        message(`m${from + i}`, (from + i) % 2 ? "assistant" : "user", `Line ${from + i}.`),
      );
    messages = lines(0, 30);
    const firstLong = await runArchivist("chat-long", { force: true });
    assert.equal(firstLong.run!.messageCount, 24);
    assert.match(firstLong.run!.detail ?? "", /First run: read the newest 24; 5 older messages left out/);
    assert.ok(modelCalls.at(-1)!.prompt.includes("Line 27.") && !modelCalls.at(-1)!.prompt.includes("Line 3."));
    assert.equal(firstLong.more, false);
    messages = [...messages, ...lines(30, 40)];
    const secondLong = await runArchivist("chat-long", { force: true });
    assert.equal(secondLong.run!.messageCount, 24);
    assert.equal(secondLong.more, true, "the rest waits for the next run");
    assert.match(secondLong.run!.detail ?? "", /16 more messages wait/);
    assert.ok(modelCalls.at(-1)!.prompt.includes("Line 29.") && !modelCalls.at(-1)!.prompt.includes("Line 53."));
    const thirdLong = await runArchivist("chat-long", { force: true });
    assert.equal(thirdLong.run!.messageCount, 16);
    assert.equal(thirdLong.more, false);
    assert.ok(modelCalls.at(-1)!.prompt.includes("Line 53.") && modelCalls.at(-1)!.prompt.includes("Line 68."));
    answer = () => '{"updates": [], "creates": []}';

    // C4: processed keys separate normal forward reads from older history, including swipes.
    const emptyAnswer = '{"updates": [], "creates": []}';
    const stateOf = (chatId: string) =>
      documents.docs.get(`archivist_state:${chatId}`)!.data as {
        lastMessageId: string | null;
        lastMessageAt: string | null;
        failedAt: string | null;
        processed: string[];
        forwardFrom: { id: string; at: string };
      };
    const bindBackfillChat = async (chatId: string, count = 60, content = (i: number) => `History ${i}.`) => {
      await saveSettings(documents, { archivist: { mode: "suggest", everyNTurns: 1, readBehind: 0 } });
      await setChatCompendiumBinding(documents, chatId, compendium.id);
      await refreshLiveClaims();
      messages = Array.from({ length: count }, (_, i) => message(`history:${i}`, "assistant", content(i)));
      answer = () => emptyAnswer;
      await runArchivist(chatId, { force: true });
    };
    const waitBackfill = async (chatId: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await getArchivistBackfillStatus(chatId);
        if (status.job?.status !== "running") return status;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("Backfill did not finish");
    };
    const holdModel = () => {
      let entered!: () => void;
      let finish!: (answer: string) => void;
      const called = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const completion = new Promise<string>((resolve) => {
        finish = resolve;
      });
      answer = () => {
        entered();
        return completion;
      };
      return {
        called,
        finish: () => {
          answer = () => emptyAnswer;
          finish(emptyAnswer);
        },
      };
    };

    await bindBackfillChat("chat-backfill");
    const initialState = structuredClone(stateOf("chat-backfill"));
    assert.equal(initialState.processed.length, 24);
    assert.equal(initialState.forwardFrom.id, "history:36");
    assert.equal(initialState.lastMessageId, "history:59");
    assert.equal((await getArchivistBackfillStatus("chat-backfill")).olderUnread, 36);
    assert.equal((await getArchivistBackfillStatus("chat-backfill")).windowsEstimated, 2);
    assert.equal(
      (await runArchivist("chat-backfill", { force: true })).status,
      "nothing_new",
      "normal never reads older gaps",
    );
    const oldest = await runArchivist("chat-backfill", { mode: "backfill" });
    assert.equal(oldest.run!.trigger, "backfill");
    assert.equal(oldest.run!.messageCount, 24);
    assert.ok(modelCalls.at(-1)!.prompt.includes("History 0.") && modelCalls.at(-1)!.prompt.includes("History 23."));
    assert.ok(!modelCalls.at(-1)!.prompt.includes("History 24."));
    assert.equal(
      (await runArchivist("chat-backfill", { force: true })).status,
      "nothing_new",
      "normal still excludes older gaps after an oldest backfill window",
    );
    assert.equal((await getArchivistBackfillStatus("chat-backfill")).olderUnread, 12);
    startArchivistBackfill("chat-backfill");
    const filled = await waitBackfill("chat-backfill");
    assert.equal(filled.job!.status, "done");
    assert.equal(filled.olderUnread, 0);
    assert.equal(stateOf("chat-backfill").processed.length, 60);
    assert.deepEqual(stateOf("chat-backfill").forwardFrom, initialState.forwardFrom);
    assert.equal(stateOf("chat-backfill").lastMessageId, initialState.lastMessageId);
    assert.equal(stateOf("chat-backfill").lastMessageAt, initialState.lastMessageAt);
    messages[45] = { ...messages[45]!, activeSwipeIndex: 1, content: "Swiped already-read reply." };
    assert.equal((await runArchivist("chat-backfill")).run!.messageCount, 1);
    assert.ok(modelCalls.at(-1)!.prompt.includes("Swiped already-read reply."));
    assert.ok(stateOf("chat-backfill").processed.includes("history:45:1"));
    assert.equal(stateOf("chat-backfill").lastMessageId, "history:59", "an old swipe keeps the watermark forward");

    // A competing write wins the revision check: retry must merge its processed key.
    const originalUpdate = documents.update.bind(documents);
    let stateWrites = 0;
    documents.update = async (input) => {
      if (input.id === "archivist_state:chat-backfill" && ++stateWrites === 1) {
        const current = documents.docs.get(input.id)!;
        messages.push(message("cas-concurrent", "assistant", "A concurrently added and read message."));
        documents.docs.set(input.id, {
          ...current,
          revision: current.revision + 1,
          data: {
            ...stateOf("chat-backfill"),
            processed: [...stateOf("chat-backfill").processed, "history:0:7", "cas-concurrent:0"],
          },
        });
        return null;
      }
      return originalUpdate(input);
    };
    messages = [...messages, message("cas-next", "assistant", "A concurrent read.")];
    try {
      await runArchivist("chat-backfill", { force: true });
    } finally {
      documents.update = originalUpdate;
    }
    assert.equal(stateWrites, 2, "revision conflict retried");
    assert.ok(
      stateOf("chat-backfill").processed.includes("history:0:7"),
      "CAS merge preserves the concurrent processed key",
    );
    assert.ok(stateOf("chat-backfill").processed.includes("cas-next:0"));
    assert.ok(
      stateOf("chat-backfill").processed.includes("cas-concurrent:0"),
      "CAS merge preserves reads of newly added messages",
    );

    // Pruning uses every persisted message, preserving hidden and newly unsettled reads and colon IDs.
    messages[40] = { ...messages[40]!, extra: JSON.stringify({ hiddenFromAI: true }) };
    messages = messages.filter((m) => m.id !== "history:41");
    await saveSettings(documents, { archivist: { readBehind: 2 } });
    messages.push(message("prune-next", "assistant", "Prune deleted messages."));
    messages.push(message("prune-last", "assistant", "Last reply."));
    // An old swipe supplies an unread settled message to force the prune write.
    messages[46] = { ...messages[46]!, activeSwipeIndex: 2 };
    await runArchivist("chat-backfill", { force: true });
    assert.ok(stateOf("chat-backfill").processed.includes("history:40:0"), "hiding never forgets a read");
    assert.ok(stateOf("chat-backfill").processed.includes("cas-next:0"), "raising Read behind never forgets a read");
    assert.ok(!stateOf("chat-backfill").processed.includes("history:41:0"), "deleted messages are pruned");

    // A queued normal run gets a turn between the job's two windows.
    await bindBackfillChat("chat-interleave");
    let interleaved: ReturnType<typeof runArchivist> | undefined;
    let firstBackfill = true;
    const interleaveOrder: string[] = [];
    const backfillWindows: string[] = [];
    answer = (prompt) => {
      backfillWindows.push(prompt);
      interleaveOrder.push(`window${backfillWindows.length}`);
      if (firstBackfill) {
        firstBackfill = false;
        interleaved = runInBackgroundQueue(() => {
          interleaveOrder.push("interleaved");
          return runArchivist("chat-interleave", { force: true });
        });
      }
      return emptyAnswer;
    };
    startArchivistBackfill("chat-interleave");
    const interleaveDone = await waitBackfill("chat-interleave");
    assert.equal((await interleaved)!.status, "nothing_new");
    assert.equal(interleaveDone.job!.windowsDone, 2);
    assert.deepEqual(interleaveOrder, ["window1", "interleaved", "window2"]);
    assert.ok(backfillWindows[0]!.includes("History 0.") && !backfillWindows[0]!.includes("History 24."));
    assert.ok(backfillWindows[1]!.includes("History 24.") && !backfillWindows[1]!.includes("History 36."));
    const backfillRuns = (await listArchivistRuns()).filter(
      (run) => run.chatId === "chat-interleave" && run.trigger === "backfill",
    );
    assert.deepEqual(
      backfillRuns.map((run) => run.messageCount).sort((a, b) => a - b),
      [12, 24],
    );

    // Real routes return 202 immediately, reject duplicate jobs with 409, and stop idempotently.
    type BackfillHandler = (
      request: { body?: unknown; query?: unknown },
      reply: typeof backfillReply,
    ) => Promise<unknown>;
    const backfillPosts = new Map<string, BackfillHandler>();
    const backfillGets = new Map<string, BackfillHandler>();
    let backfillCode = 200;
    const backfillReply = {
      code(code: number) {
        backfillCode = code;
        return this;
      },
      send(body: unknown) {
        return body;
      },
    };
    await lorebookManagerRoutes(
      {
        get(path: string, handler: BackfillHandler) {
          backfillGets.set(path, handler);
        },
        post(path: string, handler: BackfillHandler) {
          backfillPosts.set(path, handler);
        },
        put() {},
        patch() {},
        delete() {},
      } as never,
      {},
    );
    await bindBackfillChat("chat-stop");
    const held = holdModel();
    await backfillPosts.get("/archivist/backfill")!({ body: { chatId: "chat-stop" } }, backfillReply);
    assert.equal(backfillCode, 202);
    await held.called;
    const callsBeforeStop = modelCalls.length;
    await backfillPosts.get("/archivist/backfill")!({ body: { chatId: "chat-stop" } }, backfillReply);
    assert.equal(backfillCode, 409);
    backfillCode = 200;
    await backfillPosts.get("/archivist/backfill/stop")!({ body: { chatId: "chat-stop" } }, backfillReply);
    stopArchivistBackfill("chat-stop");
    assert.equal(backfillCode, 200);
    assert.equal(
      (await getArchivistBackfillStatus("chat-stop")).job!.status,
      "stopped",
      "Stop is immediate while the model is pending",
    );
    await backfillPosts.get("/archivist/backfill")!({ body: { chatId: "chat-stop" } }, backfillReply);
    assert.equal(backfillCode, 202, "a stopped job can be replaced before its model settles");
    stopArchivistBackfill("chat-stop");
    held.finish();
    await runInBackgroundQueue(async () => {});
    assert.equal((await waitBackfill("chat-stop")).job!.status, "stopped");
    assert.equal(modelCalls.length, callsBeforeStop, "Stop never starts another window");
    assert.equal(stateOf("chat-stop").processed.length, 24, "an aborted model call adds no reads");
    const routedStatus = (await backfillGets.get("/archivist/backfill")!(
      { query: { chatId: "chat-stop" } },
      backfillReply,
    )) as { olderUnread: number };
    assert.equal(routedStatus.olderUnread, 36);

    await bindBackfillChat("chat-stop-all");
    const heldStopAll = holdModel();
    startArchivistBackfill("chat-stop-all");
    await heldStopAll.called;
    const stoppingAll = stopArchivist();
    assert.equal(
      (await getArchivistBackfillStatus("chat-stop-all")).job!.status,
      "stopped",
      "deactivation marks pending jobs stopped immediately",
    );
    heldStopAll.finish();
    await stoppingAll;
    resumeArchivist();

    await bindBackfillChat("chat-backfill-failure");
    answer = () => new Error("Backfill provider failure");
    startArchivistBackfill("chat-backfill-failure");
    const failedBackfill = await waitBackfill("chat-backfill-failure");
    assert.equal(failedBackfill.job!.status, "failed");
    assert.equal(failedBackfill.job!.detail, "Backfill provider failure");
    assert.equal(stateOf("chat-backfill-failure").failedAt, null);
    const failedBackfillLog = (await listArchivistRuns()).find(
      (run) => run.chatId === "chat-backfill-failure" && run.status === "failed",
    )!;
    assert.equal(failedBackfillLog.trigger, "backfill");
    answer = () => emptyAnswer;
    messages.push(message("after-failure", "assistant", "Normal work still runs."));
    assert.equal(
      (await runArchivist("chat-backfill-failure")).status,
      "done",
      "backfill failure causes no auto cooldown",
    );
    messages.push(message("manual-after-failure", "assistant", "Run now also runs."));
    assert.equal((await runArchivist("chat-backfill-failure", { force: true })).status, "done");

    await bindBackfillChat("chat-empty-error");
    answer = () => new Error("");
    startArchivistBackfill("chat-empty-error");
    assert.equal((await waitBackfill("chat-empty-error")).job!.detail, "Backfill failed");

    // Aborting as the model answers prevents proposal, automatic, state, and log writes.
    await bindBackfillChat("chat-abort-answer");
    await saveSettings(documents, { archivist: { mode: "automatic" } });
    const abortController = new AbortController();
    const beforeAbortDocs = structuredClone([...documents.docs]);
    const beforeAbortBooks = structuredClone(books);
    answer = () => {
      abortController.abort();
      configureLorebookManagerRuntime(runtime)();
      return JSON.stringify({
        updates: [],
        creates: [{ name: "Aborted scout", category: "character", fields: [{ field: "Role", value: "Scout" }] }],
      });
    };
    try {
      const outcome = await runArchivist("chat-abort-answer", {
        mode: "backfill",
        signal: abortController.signal,
        runtime,
      });
      assert.equal(outcome.run, null);
      assert.deepEqual([...documents.docs], beforeAbortDocs);
      assert.deepEqual(books, beforeAbortBooks);
      assert.equal(
        await crawlAfterArchivist({ source: "archivist", status: "applied", appliedEntryId: "syliveera" } as never),
        null,
        "the Crawler catch never throws when runtime is unbound",
      );
    } finally {
      configureLorebookManagerRuntime(runtime);
    }

    // GET migrates in memory before any write. Failed runs never contribute to the legacy count.
    for (const count of [5, 0]) {
      const chatId = `chat-migrate-${count}`;
      await bindBackfillChat(chatId, 10);
      const watermark = messages[7]!;
      const doc = documents.docs.get(`archivist_state:${chatId}`)!;
      documents.docs.set(doc.id, {
        ...doc,
        data: { lastMessageId: watermark.id, lastMessageAt: watermark.createdAt, failedAt: null },
      });
      const log = documents.docs.get(`archivist_run:${chatId}`)!;
      documents.docs.set(log.id, {
        ...log,
        data: {
          runs: count
            ? [
                { at: watermark.createdAt, chatId, status: "done", messageCount: 2 },
                { at: watermark.createdAt, chatId, status: "failed", messageCount: 100 },
                { at: watermark.createdAt, chatId, status: "done", messageCount: 3 },
              ]
            : [],
        },
      });
      assert.equal((await getArchivistBackfillStatus(chatId)).olderUnread, count ? 3 : 7);
      assert.equal(stateOf(chatId).processed, undefined, "GET migrates in memory only");
      const migrated = await runArchivist(chatId, { force: true });
      assert.equal(migrated.run!.messageCount, 2);
      assert.ok(!migrated.run!.detail?.includes("First run"));
      assert.equal(stateOf(chatId).processed.length, (count || 1) + 2);
      assert.equal(stateOf(chatId).forwardFrom.id, count ? "history:3" : "history:7");
    }

    // Count visible history even if Read behind rose or the watermark became hidden.
    for (const hidden of [false, true]) {
      const chatId = `chat-migrate-visible-${hidden}`;
      await bindBackfillChat(chatId, 10);
      const watermark = messages[7]!;
      const doc = documents.docs.get(`archivist_state:${chatId}`)!;
      documents.docs.set(doc.id, { ...doc, data: { lastMessageId: watermark.id, lastMessageAt: watermark.createdAt } });
      const log = documents.docs.get(`archivist_run:${chatId}`)!;
      documents.docs.set(log.id, {
        ...log,
        data: { runs: [{ at: watermark.createdAt, status: "done", messageCount: 3 }] },
      });
      if (hidden) messages[7] = { ...watermark, extra: { hiddenFromAI: true } };
      await saveSettings(documents, { archivist: { readBehind: 5 } });
      const firstRead = hidden ? 4 : 5;
      assert.equal((await getArchivistBackfillStatus(chatId)).olderUnread, firstRead);
      await runArchivist(chatId, { mode: "backfill" });
      assert.equal(stateOf(chatId).forwardFrom.id, `history:${firstRead}`);
      assert.deepEqual(
        stateOf(chatId).processed.slice(0, 3),
        hidden ? ["history:4:0", "history:5:0", "history:6:0"] : ["history:5:0", "history:6:0", "history:7:0"],
      );
    }

    // An id-only boundary survives a write and the following read with an empty timestamp.
    await bindBackfillChat("chat-empty-at", 4);
    messages = messages.map((item) => ({ ...item, createdAt: "" }));
    const emptyAtDoc = documents.docs.get("archivist_state:chat-empty-at")!;
    documents.docs.set(emptyAtDoc.id, { ...emptyAtDoc, data: { lastMessageId: messages[1]!.id } });
    documents.docs.delete("archivist_run:chat-empty-at");
    assert.equal((await runArchivist("chat-empty-at", { force: true })).run!.messageCount, 2);
    assert.deepEqual(stateOf("chat-empty-at").forwardFrom, { id: "history:1", at: "" });
    assert.equal((await runArchivist("chat-empty-at", { force: true })).status, "nothing_new");
    assert.equal((await getArchivistBackfillStatus("chat-empty-at")).olderUnread, 1);

    await bindBackfillChat("chat-missing-watermark", 10);
    const gone = messages[7]!;
    const legacyDoc = documents.docs.get("archivist_state:chat-missing-watermark")!;
    documents.docs.set(legacyDoc.id, { ...legacyDoc, data: { lastMessageId: gone.id, lastMessageAt: gone.createdAt } });
    const legacyLog = documents.docs.get("archivist_run:chat-missing-watermark")!;
    documents.docs.set(legacyLog.id, {
      ...legacyLog,
      data: { runs: [{ at: gone.createdAt, status: "done", messageCount: 5 }] },
    });
    messages = messages.filter((m) => m.id !== gone.id);
    assert.equal((await getArchivistBackfillStatus("chat-missing-watermark")).olderUnread, 2);
    assert.equal((await runArchivist("chat-missing-watermark", { force: true })).run!.messageCount, 2);
    assert.equal(stateOf("chat-missing-watermark").forwardFrom.id, "history:2");

    await bindBackfillChat("chat-zero-hidden", 10);
    const hiddenWatermark = messages[7]!;
    const zeroDoc = documents.docs.get("archivist_state:chat-zero-hidden")!;
    documents.docs.set(zeroDoc.id, {
      ...zeroDoc,
      data: { lastMessageId: hiddenWatermark.id, lastMessageAt: hiddenWatermark.createdAt },
    });
    documents.docs.delete("archivist_run:chat-zero-hidden");
    messages[7] = { ...hiddenWatermark, extra: { hiddenFromAI: true } };
    assert.equal((await getArchivistBackfillStatus("chat-zero-hidden")).olderUnread, 7);
    await runArchivist("chat-zero-hidden", { force: true });
    assert.equal(stateOf("chat-zero-hidden").forwardFrom.id, hiddenWatermark.id);
    assert.ok(stateOf("chat-zero-hidden").processed.includes(`${hiddenWatermark.id}:0`));

    // A host that reports success without saving read keys must not cause a hot backfill loop.
    await bindBackfillChat("chat-no-progress");
    documents.update = async (input) => {
      if (input.id === "archivist_state:chat-no-progress") {
        return originalUpdate({ ...input, data: stateOf("chat-no-progress") });
      }
      return originalUpdate(input);
    };
    try {
      startArchivistBackfill("chat-no-progress");
      const noProgress = await waitBackfill("chat-no-progress");
      assert.equal(noProgress.job!.status, "failed");
      assert.equal(noProgress.job!.windowsDone, 1);
      assert.match(noProgress.job!.detail!, /no new reads/);
    } finally {
      documents.update = originalUpdate;
    }

    // Vanishing older messages end cleanly before the window or after a no-progress write.
    const originalListMessages = runtime.persistence.listMessages!;
    for (const phase of ["before-window", "after-write"]) {
      const chatId = `chat-vanished-${phase}`;
      await bindBackfillChat(chatId);
      let reads = 0;
      runtime.persistence.listMessages = async () => {
        if (phase === "before-window" && ++reads === 2) messages = messages.slice(36);
        return messages;
      };
      documents.update = async (input) => {
        if (phase === "after-write" && input.id === `archivist_state:${chatId}`) {
          messages = messages.slice(36);
          return originalUpdate({ ...input, data: stateOf(chatId) });
        }
        return originalUpdate(input);
      };
      try {
        startArchivistBackfill(chatId);
        const vanished = await waitBackfill(chatId);
        assert.equal(vanished.job!.status, "done");
        assert.equal(vanished.olderUnread, 0);
        assert.equal(vanished.job!.detail, undefined);
      } finally {
        runtime.persistence.listMessages = originalListMessages;
        documents.update = originalUpdate;
      }
    }

    // Backfill ignores automatic scheduling gates while retaining any existing cooldown and watermark.
    await bindBackfillChat("chat-bypass");
    const bypassDoc = documents.docs.get("archivist_state:chat-bypass")!;
    const failedAt = new Date().toISOString();
    documents.docs.set(bypassDoc.id, { ...bypassDoc, data: { ...stateOf("chat-bypass"), failedAt } });
    await saveSettings(documents, { archivist: { mode: "off", everyNTurns: 99 } });
    metadata = { enableAgents: false, activeAgentIds: [] };
    messages.push(message("pending-user", "user", "The reply is still pending."));
    startArchivistBackfill("chat-bypass");
    assert.equal((await waitBackfill("chat-bypass")).olderUnread, 0);
    assert.equal(stateOf("chat-bypass").failedAt, failedAt);
    assert.equal(stateOf("chat-bypass").lastMessageId, "history:59");
    metadata = ADDED;

    // A hidden boundary still divides messages by persisted order, even with identical timestamps.
    await bindBackfillChat("chat-hidden-boundary", 3);
    messages[0] = { ...messages[0]!, createdAt: messages[1]!.createdAt };
    messages[1] = { ...messages[1]!, extra: { hiddenFromAI: true } };
    const hiddenBoundaryDoc = documents.docs.get("archivist_state:chat-hidden-boundary")!;
    documents.docs.set(hiddenBoundaryDoc.id, {
      ...hiddenBoundaryDoc,
      data: {
        ...stateOf("chat-hidden-boundary"),
        forwardFrom: { id: messages[1]!.id, at: messages[1]!.createdAt },
        processed: ["history:1:0", "history:2:0"],
      },
    });
    assert.equal((await getArchivistBackfillStatus("chat-hidden-boundary")).olderUnread, 1);
    assert.equal((await runArchivist("chat-hidden-boundary", { force: true })).status, "nothing_new");

    // Binding and model-host preconditions are checked synchronously before starting a job.
    await backfillPosts.get("/archivist/backfill")!({ body: { chatId: "unbound-chat" } }, backfillReply);
    assert.equal(backfillCode, 400);
    const languageModels = runtime.languageModels;
    runtime.languageModels = undefined;
    try {
      await backfillPosts.get("/archivist/backfill")!({ body: { chatId: "chat-bypass" } }, backfillReply);
      assert.equal(backfillCode, 501);
    } finally {
      runtime.languageModels = languageModels;
    }

    // The processed-key cap evicts the earliest saved keys while retaining newly read keys.
    await bindBackfillChat("chat-key-cap", 2);
    const capDoc = documents.docs.get("archivist_state:chat-key-cap")!;
    documents.docs.set(capDoc.id, {
      ...capDoc,
      data: {
        ...stateOf("chat-key-cap"),
        forwardFrom: { id: messages[1]!.id, at: messages[1]!.createdAt },
        processed: [...Array.from({ length: 20_000 }, (_, i) => `history:0:${i}`), "history:1:0"],
      },
    });
    messages.push(message("cap-new", "assistant", "New capped read."));
    await runArchivist("chat-key-cap", { force: true });
    assert.equal(stateOf("chat-key-cap").processed.length, 20_000);
    assert.ok(!stateOf("chat-key-cap").processed.includes("history:0:0"));
    assert.ok(stateOf("chat-key-cap").processed.includes("cap-new:0"));

    // Long messages hit the character limit before the count limit; the job stops at 40 windows.
    await bindBackfillChat("chat-long-backfill", 65, (i) => `Long ${i}:` + "x".repeat(16_000));
    const longStatus = await getArchivistBackfillStatus("chat-long-backfill");
    assert.equal(longStatus.olderUnread, 64);
    assert.equal(longStatus.windowsEstimated, 64);
    startArchivistBackfill("chat-long-backfill");
    const capped = await waitBackfill("chat-long-backfill");
    assert.equal(capped.job!.windowsDone, 40);
    assert.match(capped.job!.detail!, /safety cap of 40 windows/);
    assert.equal(capped.olderUnread, 24);
    assert.equal(
      (await listArchivistRuns()).filter((run) => run.chatId === "chat-long-backfill").length,
      41,
      "expanded log retains the normal run",
    );

    await bindBackfillChat("chat-exact-cap", 41, (i) => `Long ${i}:` + "x".repeat(16_000));
    startArchivistBackfill("chat-exact-cap");
    const exactCap = await waitBackfill("chat-exact-cap");
    assert.equal(exactCap.job!.windowsDone, 40);
    assert.equal(exactCap.job!.status, "done");
    assert.equal(exactCap.job!.detail, undefined);
    assert.equal(exactCap.olderUnread, 0);

    // Automatic uses the same write and Crawler paths, while approval and duplicate creates stay in Review.
    await saveSettings(documents, { archivist: { mode: "automatic", everyNTurns: 1, readBehind: 0 } });
    await setChatCompendiumBinding(documents, "chat-auto", compendium.id);
    await refreshLiveClaims();
    const autoEntry = () => books[0]!.entries.find((entry) => entry.id === "syliveera")!;
    const beforeAuto = String(autoEntry().content);
    metadata = { ...JSON.parse(ADDED), agentWriteApprovalRequired: false };
    messages = [message("auto-1", "assistant", "Syliveera keeps a gold ring. The Thorn Gate is sealed.")];
    answer = (prompt) =>
      JSON.stringify({
        updates: [
          { id: shortId(prompt, "Syliveera"), fields: [{ field: "Currently", value: "Carries a gold ring" }] },
          { id: shortId(prompt, "Thorn Gate"), fields: [{ field: "Status", value: "Locked" }] },
        ],
        creates: [],
      });
    const realSetTimeout = globalThis.setTimeout;
    let scheduledCrawls = 0;
    // Shorten only the Crawler's production debounce, proving Automatic schedules it without a test calling it.
    globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 20_000) scheduledCrawls += 1;
      return realSetTimeout(callback, delay === 20_000 ? 0 : delay, ...args);
    }) as typeof setTimeout;
    let autoRun: Awaited<ReturnType<typeof runArchivist>>;
    try {
      autoRun = await runArchivist("chat-auto");
      answer = () => JSON.stringify({ entries: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(scheduledCrawls, 1, "Automatic invoked the after-Archivist Crawler hook");
    const automatic = (await listProposals(documents)).find((proposal) => proposal.id === autoRun.run!.proposalIds[0])!;
    assert.equal(automatic.status, "applied");
    assert.equal(automatic.appliedBy, "automatic");
    assert.deepEqual(automatic.before, { content: beforeAuto });
    assert.deepEqual(automatic.after, {
      content: beforeAuto.replace("Currently: Carries a silver knife", "Currently: Carries a gold ring"),
    });
    assert.ok(!(await listProposals(documents, "pending")).some((proposal) => proposal.id === automatic.id));
    assert.ok(autoRun.run!.skipped.some((item) => item.why === "locked"));

    for (let attempt = 0; attempt < 20 && (await listCrawlerRuns()).length === 0; attempt++) {
      await new Promise((resolve) => realSetTimeout(resolve, 10));
    }
    const tidied = (await listCrawlerRuns())[0];
    assert.equal(tidied?.trigger, "after_archivist");
    assert.deepEqual(tidied?.entryIds, ["syliveera"]);
    assert.equal((await listCrawlerRuns()).filter((run) => run.trigger === "after_archivist").length, 1);
    assert.equal((await undoProposal(runtime, automatic.id)).status, "undone");
    assert.equal(autoEntry().content, beforeAuto);
    await assert.rejects(
      () => undoProposal(runtime, automatic.id),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409,
    );
    assert.equal((await listProposals(documents, "undone")).length, 1);

    // Both host metadata shapes require approval; switching it on during a model call also prevents auto-apply.
    for (const shape of ["string", "object", "during-call"]) {
      metadata =
        shape === "during-call"
          ? ADDED
          : shape === "string"
            ? JSON.stringify({ ...JSON.parse(ADDED), agentWriteApprovalRequired: true })
            : { ...JSON.parse(ADDED), agentWriteApprovalRequired: true };
      messages = [...messages, message(`approval-${shape}`, "assistant", "Syliveera carries a lantern.")];
      answer = (prompt) => {
        if (shape === "during-call") metadata = { ...JSON.parse(ADDED), agentWriteApprovalRequired: true };
        return JSON.stringify({
          updates: [
            { id: shortId(prompt, "Syliveera"), fields: [{ field: "Currently", value: `Carries a ${shape} lantern` }] },
          ],
          creates: [],
        });
      };
      const approval = await runArchivist("chat-auto");
      const waiting = (await listProposals(documents, "pending")).find((proposal) =>
        approval.run!.proposalIds.includes(proposal.id),
      )!;
      assert.equal(waiting.status, "pending");
      assert.equal(autoEntry().content, beforeAuto);
      await dismissProposal(documents, waiting.id);
    }

    metadata = ADDED; // absent approval switch means off, including a JSON-string host record.
    messages = [...messages, message("auto-create", "assistant", "Neris lives at the Unseelie Court.")];
    answer = () =>
      JSON.stringify({
        updates: [],
        creates: [
          { name: "Syliveera Envoy", category: "character", fields: [{ field: "Role", value: "Envoy" }] },
          { name: "Neris", category: "character", fields: [{ field: "Role", value: "Fae scout" }] },
        ],
      });
    const creations = await runArchivist("chat-auto");
    const createdProposals = (await listProposals(documents)).filter((proposal) =>
      creations.run!.proposalIds.includes(proposal.id),
    );
    const duplicate = createdProposals.find((proposal) => proposal.duplicateOfEntryId)!;
    const createdAuto = createdProposals.find((proposal) => proposal.entryName === "Neris")!;
    assert.equal(duplicate.status, "pending");
    assert.equal(createdAuto.status, "applied");
    assert.equal(createdAuto.before, null);
    assert.equal(createdAuto.after!.content, "Role: Fae scout");
    answer = () => JSON.stringify({ entries: [] });
    await crawlAfterArchivist(createdAuto, { waitMs: 0 });
    const neris = books[1]!.entries.find((entry) => entry.id === createdAuto.appliedEntryId)!;
    neris.keys = ["Neris", "Scout"];
    await assert.rejects(
      () => undoProposal(runtime, createdAuto.id),
      /Changed since: Undo would overwrite newer edits/,
    );
    assert.ok(books[1]!.entries.includes(neris), "an edited create is not deleted");
    neris.keys = structuredClone(createdAuto.after!.keys);
    // The Engine rewrites fields the create never set (vectorization, timestamps): Undo still works.
    Object.assign(neris, { embedding: [0.1, 0.2], updatedAt: "2099-01-01T00:00:00.000Z" });
    assert.equal((await undoProposal(runtime, createdAuto.id)).status, "undone");
    assert.ok(!books[1]!.entries.some((entry) => entry.id === createdAuto.appliedEntryId));

    // Manual changes use the same snapshots, preserving unrelated edits while reverting only changed fields.
    const manual = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "syliveera",
      entryName: "Syliveera",
      patch: { content: "Manual content.", keys: ["Syliveera", "Queen"], relationships: { unseelie: "member_of" } },
      source: "archivist",
    });
    const oldKeys = structuredClone(autoEntry().keys);
    const manuallyApplied = await applyProposal(runtime, manual.id);
    assert.equal(manuallyApplied.appliedBy, "manual");
    autoEntry().tag = "character";
    autoEntry().relationships = { unseelie: "member_of" }; // equal objects compare by value, not identity.
    await undoProposal(runtime, manual.id);
    assert.equal(autoEntry().content, beforeAuto);
    assert.deepEqual(autoEntry().keys, oldKeys);
    assert.equal(autoEntry().tag, "character");
    const newer = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "syliveera",
      entryName: "Syliveera",
      patch: { newFacts: ["Syliveera owns a boat."] },
      source: "archivist",
    });
    const legacyFolded = await appendProposalFieldEdits(
      documents,
      newer,
      [{ field: "Rank", from: "Jōnin", to: "Captain" }],
      [],
    );
    assert.deepEqual(legacyFolded!.patch.newFacts, ["Syliveera owns a boat."]);
    const cancelled = await appendProposalFieldEdits(
      documents,
      legacyFolded!,
      sheetFieldEdits("Rank: Jōnin", ["Rank"], [{ field: "rank", value: "Jōnin" }], true),
      [],
    );
    assert.deepEqual(cancelled!.patch.fieldEdits, [], "newest baseline value cancels the older edit");
    await appendProposalFieldEdits(documents, cancelled!, [{ field: "Rank", from: "Jōnin", to: "Captain" }], []);
    await applyProposal(runtime, newer.id);
    assert.match(String(autoEntry().content), /Syliveera owns a boat\./);
    assert.match(String(autoEntry().content), /Rank: Captain/);
    assert.equal(autoEntry().fieldEdits, undefined);
    assert.equal(autoEntry().newFacts, undefined);
    autoEntry().content = "A newer edit must survive.";
    const editedEntry = structuredClone(autoEntry());
    // Exercise the actual route's status and error body without a server or network listener.
    type Handler = (request: { params: { id: string } }, reply: unknown) => Promise<unknown>;
    const posts = new Map<string, Handler>();
    const app = {
      get() {},
      put() {},
      patch() {},
      delete() {},
      post(path: string, handler: Handler) {
        posts.set(path, handler);
      },
    };
    await lorebookManagerRoutes(app as never, {});
    let statusCode = 200;
    const reply = {
      code(status: number) {
        statusCode = status;
        return this;
      },
      send(body: unknown) {
        return body;
      },
    };
    const conflict = await posts.get("/proposals/:id/undo")!({ params: { id: newer.id } }, reply);
    assert.equal(statusCode, 409);
    assert.deepEqual(conflict, { error: "Changed since: Undo would overwrite newer edits" });
    assert.deepEqual(autoEntry(), editedEntry);
    autoEntry().content = beforeAuto;

    // Empty sheets use prose, including lore/concept and unknown categories; event uses quest fields.
    await saveSettings(documents, { archivist: { mode: "suggest" }, sheets: { character: [] } });
    await setChatCompendiumBinding(documents, "chat-prose", compendium.id);
    await refreshLiveClaims();
    messages = [
      message("prose-1", "assistant", "Asha is a watcher. Dawn Vigil guards the road. The Pact binds names."),
    ];
    answer = () =>
      JSON.stringify({
        updates: [],
        creates: [
          { name: "Asha", category: "character", content: "Asha is a watcher." },
          {
            name: "Dawn Vigil",
            category: "event",
            fields: [
              { field: "Status", value: "Active" },
              { field: "Goal", value: "Guard the road" },
            ],
          },
          { name: "The Pact", category: "concept", content: "The Pact binds names." },
          { name: "Namebinding", category: "unknown", content: "Names can be bound." },
        ],
      });
    const proseRun = await runArchivist("chat-prose", { force: true });
    const proseProposals = (await listProposals(documents)).filter((proposal) =>
      proseRun.run!.proposalIds.includes(proposal.id),
    );
    assert.equal(proseRun.run!.creates, 4);
    assert.equal(proseProposals.find((p) => p.entryName === "Asha")!.patch.content, "Asha is a watcher.");
    assert.equal(
      proseProposals.find((p) => p.entryName === "Dawn Vigil")!.patch.content,
      "Goal: Guard the road\nStatus: Active",
    );
    assert.equal(proseProposals.find((p) => p.entryName === "The Pact")!.patch.content, "The Pact binds names.");
    assert.equal(proseProposals.find((p) => p.entryName === "Namebinding")!.patch.content, "Names can be bound.");

    // A real activation without live-retrieval APIs still loads bindings and owns Backfill's lifecycle.
    await bindBackfillChat("chat-old-engine");
    resetLiveClaims();
    await stopArchivist();
    const deactivate = await activate({
      api: {
        runtime,
        async registerPrivilegedRoutes() {
          return () => {};
        },
      },
    });
    const deactivationHeld = holdModel();
    startArchivistBackfill("chat-old-engine");
    await deactivationHeld.called;
    const deactivationCalls = modelCalls.length;
    deactivate(); // The global runtime is unbound immediately, before the fake model finishes.
    deactivationHeld.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    configureLorebookManagerRuntime(runtime);
    await refreshLiveClaims();
    assert.equal((await waitBackfill("chat-old-engine")).job!.status, "stopped");
    assert.equal(modelCalls.length, deactivationCalls);
    assert.equal(stateOf("chat-old-engine").processed.length, 24);
    resumeArchivist();

    // ── The contributor arms the job on a real turn, never on a preview; stopping clears it. ──
    await saveSettings(documents, { archivist: { mode: "suggest" } });
    const request = { chatId: "chat-1", chatMeta: JSON.parse(ADDED) as Record<string, unknown>, mode: "roleplay" };
    await contributeLiveLore({ ...request, preview: true });
    assert.equal(isArchivistArmed("chat-1"), false, "a Peek arms nothing");
    await contributeLiveLore(request);
    assert.equal(isArchivistArmed("chat-1"), true);
    await stopArchivist();
    assert.equal(isArchivistArmed("chat-1"), false);
    armArchivist("chat-1");
    assert.equal(isArchivistArmed("chat-1"), false, "nothing arms after deactivation");
    resumeArchivist();
  } finally {
    await stopArchivist();
    resumeArchivist();
    resetLiveClaims();
    release();
  }
}

main()
  .then(() => console.log("lorebook-manager-archivist.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
