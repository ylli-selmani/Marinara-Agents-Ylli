/**
 * B1a: the Archivist. Lookup-then-Diff over settled messages past the watermark, one model call, suggestions into
 * Review. A fake model host answers in the Engine's real shapes; no model is called for real.
 * Run: npx tsx --tsconfig tests/tsconfig.regressions.json tests/lorebook-manager-archivist.regression.ts
 */
import assert from "node:assert/strict";
import {
  ARCHIVIST_SYSTEM,
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
  dismissProposal,
  listProposals,
  mergeNewFacts,
  novelFacts,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/proposals-store.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
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
      { id: "syliveera", name: "Syliveera", keys: ["Syliveera"], content: "Syliveera greets {{user}} coldly." },
      { id: "gate", name: "Thorn Gate", keys: ["Thorn Gate"], locked: true, content: "The Thorn Gate never opens." },
    ] as Array<Record<string, unknown>>,
  },
  { id: "cast", data: { name: "Cast", category: "character" }, entries: [] as Array<Record<string, unknown>> },
];

// The chat's metadata arrives as a JSON string from the host (capability-persistence `mapChat`).
const ADDED = JSON.stringify({ enableAgents: true, activeAgentIds: ["lorebook-manager"] });

type Answer = (prompt: string) => string | Error;

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
            const reply = answer(prompt);
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
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  /** The short id the prompt gave an entry ("[c2] Syliveera" → c2). */
  const shortId = (prompt: string, name: string) => new RegExp(`\\[(c\\d+)\\] ${name} `).exec(prompt)?.[1] ?? "c?";
  try {
    const compendium = await createCompendium(documents, { name: "Fae", lorebookIds: ["court", "cast"] });
    await setChatCompendiumBinding(documents, "chat-1", compendium.id);
    await refreshLiveClaims();
    await saveSettings(documents, { archivist: { mode: "suggest", everyNTurns: 2, unreadMessages: 2 } });

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

    // ── Due: u1..a4 settled (u5 + a6 unread), two replies. ──
    messages = [...messages, message("a6", "assistant", "The night deepens.")];
    answer = (prompt) =>
      JSON.stringify({
        updates: [
          {
            id: shortId(prompt, "Syliveera"),
            facts: ["Syliveera now serves the Seelie Queen.", "Syliveera greets {{user}} coldly."],
          },
          { id: shortId(prompt, "Thorn Gate"), facts: ["Brannoc forged its lock."] },
          { id: "c99", facts: ["Nothing."] },
        ],
        creates: [
          { name: "Brannoc the Smith", category: "character", content: "Brannoc is a fae smith.", keys: [] },
          { name: "unseelie court", category: "faction", content: "A court of the night.", keys: ["Night Court"] },
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
    assert.ok(!call.prompt.includes("The night deepens"), "the unread reply is not");
    assert.ok(
      /\[c\d+\] Syliveera /.test(call.prompt) && /\[c\d+\] Thorn Gate /.test(call.prompt),
      "looked-up entries in full",
    );

    const pending = await listProposals(documents, "pending");
    const update = pending.find((p) => p.kind === "update_entry")!;
    assert.equal(update.targetEntryId, "syliveera");
    assert.deepEqual(update.patch, { newFacts: ["Syliveera now serves the Seelie Queen."] }, "known facts dropped");
    assert.deepEqual(
      update.sourceMessageRefs.map((ref) => `${ref.messageId}:${ref.swipeIndex}`),
      ["u1:0", "a2:0", "u3:0", "a4:2"],
      "sources carry the visible swipe",
    );
    const brannoc = pending.find((p) => p.entryName === "Brannoc the Smith")!;
    assert.equal(brannoc.lorebookId, "cast", "a character lands in the character book");
    assert.deepEqual(brannoc.patch, {
      content: "Brannoc is a fae smith.",
      keys: ["Brannoc the Smith"],
      tag: "character",
    });
    assert.equal(brannoc.duplicateOfEntryId, null);
    const dup = pending.find((p) => p.entryName === "unseelie court")!;
    assert.equal(dup.duplicateOfEntryId, "unseelie", "a create named like an entry is flagged, still in Review");
    assert.equal(dup.lorebookId, "court");
    assert.equal(pending.length, 3, "the locked entry and the unknown id made nothing");
    const run = done.run!;
    assert.deepEqual(run.skipped.map((s) => s.why).sort(), ["locked", "unknown entry"], JSON.stringify(run.skipped));
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
        updates: [{ id: shortId(prompt, "Syliveera"), facts: ["Syliveera keeps a silver knife."] }],
        creates: [{ name: "Brannoc the Smith", category: "character", content: "Again.", keys: [] }],
      });
    const second = await runArchivist("chat-1");
    assert.equal(second.status, "done");
    assert.ok(modelCalls[1]!.prompt.includes("The night deepens"), "the window starts after the watermark");
    assert.ok(!modelCalls[1]!.prompt.includes("Brannoc the Smith forged"), "...and not before it");
    const afterSecond = await listProposals(documents, "pending");
    assert.equal(afterSecond.length, 3, "folded, not a fourth suggestion");
    const folded = afterSecond.find((p) => p.id === update.id)!;
    assert.deepEqual(folded.patch.newFacts, [
      "Syliveera now serves the Seelie Queen.",
      "Syliveera keeps a silver knife.",
    ]);
    assert.ok(folded.sourceMessageRefs.some((ref) => ref.messageId === "a8"));
    assert.deepEqual(second.run!.skipped, [{ name: "Brannoc the Smith", why: "already suggested" }]);

    // ── Apply merges the facts into the entry as it is now; a dismissed create is never suggested again. ──
    books[0]!.entries[1]!.content = "Syliveera greets {{user}} coldly. She hates iron.";
    const applied = await applyProposal(runtime, update.id);
    assert.equal(
      books[0]!.entries[1]!.content,
      "Syliveera greets {{user}} coldly. She hates iron.\n\nSyliveera now serves the Seelie Queen. Syliveera keeps a silver knife.",
    );
    assert.deepEqual(
      applied.before,
      { content: "Syliveera greets {{user}} coldly. She hates iron." },
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
        creates: [{ name: "Brannoc the Smith", category: "character", content: "Third.", keys: [] }],
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
