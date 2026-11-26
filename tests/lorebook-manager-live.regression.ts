/**
 * Slice 3a: live Stage 1 retrieval. A chat bound to a Compendium claims that Compendium's books (so the Engine's
 * scan skips them) and gets them through the package's prompt-context contributor instead.
 * Slice 3b: the Activity listing of those runs, and the Review store (apply / dismiss suggested entry changes).
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
  listLiveRuns,
  recentQueryText,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-retrieval.js";
import {
  applyProposal,
  createProposal,
  dismissProposal,
  listProposals,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/proposals-store.js";
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
    persistence: {
      documents,
      // The real host puts chat reads on persistence; a fake that put them on resources hid a live bug in 3a.
      async listMessages() {
        return messages;
      },
      async getChat(chatId) {
        return { id: chatId, name: "Fae night", characterIds: ["ash"], personaId: "ylva" };
      },
    },
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
      async createLorebookEntry(lorebookId, entry) {
        const id = `new-${writes.length}`;
        writes.push({ op: "create", id: lorebookId, fields: entry });
        return { id, lorebookId, data: { ...entry, id } };
      },
      async updateLorebookEntry(entryId, patch) {
        const entry = books
          .flatMap((book) => book.entries as Array<Record<string, unknown>>)
          .find((e) => e.id === entryId);
        if (!entry) return null;
        if (entry.locked === true) throw new Error("This entry is locked");
        writes.push({ op: "update", id: entryId, fields: patch });
        Object.assign(entry, patch);
        return { id: entryId, lorebookId: "court", data: entry };
      },
    },
  };
  const writes: Array<{ op: string; id: string; fields: Record<string, unknown> }> = [];
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

    // Activity: chats with runs, named, newest first, reasons carry their detail.
    const activity = await listLiveRuns();
    assert.equal(activity.length, 1);
    assert.equal(activity[0]!.chatName, "Fae night");
    const unseelie = activity[0]!.runs[1]!.activated.find((item) => item.ref === "lore:unseelie");
    assert.ok(unseelie?.reasons.some((reason) => reason.kind === "keyword" && reason.detail.length > 0));

    // Review: dismiss, apply an update (with an Undo snapshot), apply a create, refuse a locked entry.
    const toDismiss = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "unseelie",
      entryName: "Unseelie Court",
      patch: { description: "Wrong." },
      source: "archivist",
    });
    await dismissProposal(documents, toDismiss.id);
    await assert.rejects(() => applyProposal(runtime, toDismiss.id), /already handled/u);

    const update = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "syliveera",
      entryName: "Syliveera",
      patch: { description: "Queen of the night court." },
      reason: "Named queen in the last reply.",
      source: "archivist",
      chatId: "chat-1",
      sourceMessageRefs: [{ messageId: "6", swipeIndex: 0 }],
    });
    assert.equal((await listProposals(documents, "pending")).length, 1);
    const applied = await applyProposal(runtime, update.id);
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.before, { description: null }, "the old value is kept for Undo");
    assert.deepEqual(writes.at(-1), {
      op: "update",
      id: "syliveera",
      fields: { description: "Queen of the night court." },
    });

    const create = await createProposal(documents, {
      kind: "create_entry",
      lorebookId: "court",
      entryName: "Moonlit Hall",
      patch: { content: "A hall of silver light.", keys: ["Moonlit Hall"] },
      source: "crawler",
    });
    const created = await applyProposal(runtime, create.id);
    assert.equal(created.appliedEntryId, "new-1");
    assert.deepEqual(writes.at(-1)?.fields, {
      name: "Moonlit Hall",
      content: "A hall of silver light.",
      keys: ["Moonlit Hall"],
    });

    (books[0]!.entries[2] as Record<string, unknown>).locked = true;
    const locked = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "oath",
      entryName: "Oath",
      patch: { content: "Changed." },
      source: "archivist",
    });
    await assert.rejects(() => applyProposal(runtime, locked.id), /locked/u);
    assert.equal(
      (await listProposals(documents, "pending")).map((proposal) => proposal.id).join(),
      locked.id,
      "a refused change stays pending",
    );

    const oldEngine = { ...runtime, resources: { ...runtime.resources, updateLorebookEntry: undefined } };
    await assert.rejects(() => applyProposal(oldEngine, locked.id), /Capability API 1\.839/u);

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
