/**
 * Slice 3a: live Stage 1 retrieval. A chat bound to a Compendium claims that Compendium's books (so the Engine's
 * scan skips them) and gets them through the package's prompt-context contributor instead.
 */
import assert from "node:assert/strict";
import {
  createCompendium,
  setChatCompendiumBinding,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  claimLorebooksForChat,
  refreshLiveClaims,
  resetLiveClaims,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import {
  contributeLiveLore,
  recentQueryText,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";

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

const message = (id: string, role: string, content: string, extra: unknown = "{}"): LorebookManagerMessageRecord => ({
  id,
  role,
  content,
  extra,
  createdAt: `2026-11-26T00:00:0${id}Z`,
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
      { id: "oath", name: "Oath", constant: true, content: "Every fae keeps their word." },
    ],
  },
  {
    id: "rain",
    data: { name: "Weather", category: "world" },
    entries: [{ id: "rain-entry", name: "Rain", keys: ["court"], content: "Rain lore." }],
  },
];

async function main() {
  const documents = makeMemoryDocStore();
  const lorebookCalls: Array<string[] | undefined> = [];
  let messages: LorebookManagerMessageRecord[] = [];
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: { documents },
    resources: {
      async listLorebooks(ids) {
        lorebookCalls.push(ids);
        return ids ? books.filter((book) => ids.includes(book.id)) : books;
      },
      async listCharacters(ids) {
        return [{ id: "ash", data: { name: "Ash" }, comment: "" }].filter((row) => !ids || ids.includes(row.id));
      },
      async listPersonas(ids) {
        return [{ id: "ylva", data: { name: "Ylva" } }].filter((row) => !ids || ids.includes(row.id));
      },
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return { id: chatId, characterIds: ["ash"], personaId: "ylva" };
      },
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  try {
    // Query window: the last N visible user/assistant messages, oldest first.
    const window = [
      message("1", "user", "Syliveera waits."),
      message("2", "assistant", "We walk on."),
      message("3", "system", "A note."),
      message("4", "user", "Hidden aside.", JSON.stringify({ hiddenFromAI: true })),
      message("5", "user", "We reach the Unseelie Court."),
    ];
    assert.equal(recentQueryText(window, 2), "We walk on.\n\nWe reach the Unseelie Court.");
    assert.equal(recentQueryText(window, 3), "Syliveera waits.\n\nWe walk on.\n\nWe reach the Unseelie Court.");

    const compendium = await createCompendium(documents, {
      name: "Fae",
      lorebookIds: ["court"],
      retrievalSettings: { queryMessageCount: 2 },
    });
    assert.equal(compendium.retrievalSettings.queryMessageCount, 2);
    await setChatCompendiumBinding(documents, "chat-1", compendium.id);
    await refreshLiveClaims();

    assert.deepEqual(claimLorebooksForChat({ chatId: "chat-1" }), ["court"]);
    assert.equal(claimLorebooksForChat({ chatId: "chat-2" }), null, "an unbound chat claims nothing");

    messages = window;
    const request = { chatId: "chat-1", chatMeta: {}, mode: "roleplay", wrapFormat: "xml" as const };
    const text = await contributeLiveLore(request);
    assert.ok(text?.startsWith("<world_info>"), String(text));
    assert.match(text!, /The Unseelie Court rules the night\./);
    assert.match(text!, /Every fae keeps their word\./, "constants come along");
    assert.doesNotMatch(text!, /Syliveera greets/, "a name three messages back is outside a 2-message window");
    assert.doesNotMatch(text!, /Rain lore/, "only the bound Compendium's books");
    assert.ok(
      lorebookCalls.every((ids) => Array.isArray(ids) && ids.length === 1 && ids[0] === "court"),
      `live retrieval fetches only the Compendium's books: ${JSON.stringify(lorebookCalls)}`,
    );

    messages = [...window, message("6", "assistant", "Syliveera rises.")];
    const withName = await contributeLiveLore(request);
    assert.match(withName!, /Syliveera greets Ylva coldly\./, "{{user}} becomes the chat's persona");

    assert.equal(await contributeLiveLore({ ...request, chatId: "chat-2" }), null, "unbound chats get nothing");

    // The run log for the Activity tab is written in the background.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const runs = (documents.docs.get("live_run:chat-1")?.data as { runs?: Array<{ activated: unknown[] }> })?.runs;
    assert.equal(runs?.length, 2, "both runs are recorded, newest first");

    await setChatCompendiumBinding(documents, "chat-1", null);
    await refreshLiveClaims();
    assert.equal(claimLorebooksForChat({ chatId: "chat-1" }), null, "unbinding releases the claim");
  } finally {
    resetLiveClaims();
    release();
  }
}

main()
  .then(() => console.log("lorebook-manager-live.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
