/**
 * B2a: the Crawler (Tidy entries). One model call per batch fills in a missing summary and tag, adds keywords and
 * links to mentioned entries; suggestions go to Review and merge into the entry as it is at Apply. A fake model host
 * answers; no model is called for real.
 * Run: npx tsx --tsconfig tests/tsconfig.regressions.json tests/lorebook-manager-crawler.regression.ts
 */
import assert from "node:assert/strict";
import { createCompendium } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  CRAWLER_SYSTEM,
  countUntidied,
  crawlAfterArchivist,
  crawlHash,
  listCrawlerRuns,
  runCrawler,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/crawler.js";
import { resetLiveClaims } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
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
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import { saveSettings } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/settings-store.js";

function makeMemoryDocStore(): LorebookManagerDocumentStore {
  const docs = new Map<string, LorebookManagerDocumentRecord>();
  return {
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

const books = [
  {
    id: "court",
    data: { name: "Fae Court", category: "world" },
    entries: [
      {
        id: "unseelie",
        name: "Unseelie Court",
        keys: ["Unseelie Court", "Unseelie"],
        content: "The Unseelie Court rules the night.",
      },
      {
        id: "syliveera",
        name: "Syliveera",
        keys: ["Syliveera"],
        description: "",
        tag: "",
        content: "Syliveera serves the Unseelie Court and guards the Thorn Gate.",
        relationships: { gate: "related_to" },
      },
      { id: "gate", name: "Thorn Gate", keys: ["Thorn Gate"], locked: true, content: "The Thorn Gate never opens." },
    ] as Array<Record<string, unknown>>,
  },
];
const entry = (id: string) => books[0]!.entries.find((item) => item.id === id)!;

type Answer = (prompt: string) => string | Error;

async function main() {
  assert.equal(crawlHash({ name: "A", content: "x" }), crawlHash({ name: "A", content: "x" }));
  assert.notEqual(crawlHash({ name: "A", content: "x" }), crawlHash({ name: "A", content: "y" }));
  assert.ok(!CRAWLER_SYSTEM.includes("represents"), "the Crawler never writes represents links");

  const documents = makeMemoryDocStore();
  const prompts: string[] = [];
  let answer: Answer = () => '{"entries": []}';
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: {
      documents,
      async getChat(chatId) {
        return { id: chatId, name: "Fae night", characterIds: [], personaId: null, connectionId: "conn-chat" };
      },
    },
    languageModels: {
      async resolveForRequest(request) {
        return {
          connectionId: request.connectionId ?? request.chatConnectionId ?? "default",
          model: "fake-model",
          async chatComplete(chat) {
            const prompt = chat.find((m) => m.role === "user")?.content ?? "";
            prompts.push(prompt);
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
      async createLorebookEntry(lorebookId, data) {
        const id = `new-${String(data.name)}`;
        books[0]!.entries.push({ ...data, id });
        return { id, lorebookId, data: { ...data, id } };
      },
      async updateLorebookEntry(entryId, patch) {
        const target = books.flatMap((book) => book.entries).find((e) => e.id === entryId);
        if (!target) return null;
        if (target.locked === true) throw new Error("This entry is locked");
        Object.assign(target, patch);
        return { id: entryId, lorebookId: "court", data: target };
      },
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  const shortId = (prompt: string, name: string) => new RegExp(`\\[(e\\d+)\\] ${name}\\n`).exec(prompt)?.[1] ?? "e?";
  try {
    const compendium = await createCompendium(documents, { name: "Fae", lorebookIds: ["court"] });

    // ── Locked entries are never tidied; the rest wait. ──
    assert.equal(await countUntidied(compendium.id), 2);

    // ── A batch: gaps first, targets from mentions, unknown ids / targets / relations left out. ──
    answer = (prompt) => {
      const syl = shortId(prompt, "Syliveera");
      const court = shortId(prompt, "Unseelie Court");
      const target = /targets: (t\d+) Unseelie Court/.exec(prompt)?.[1] ?? "t?";
      return JSON.stringify({
        entries: [
          {
            id: syl,
            description: "A fae knight of the Unseelie Court.",
            tag: "Character",
            keys: ["Syl", "syliveera", "Knight of Thorns"],
            links: [
              { to: target, relation: "member_of" },
              { to: "t99", relation: "ally_of" },
              { to: target, relation: "represents" },
            ],
          },
          { id: court, description: "The night court of the fae.", tag: "faction", keys: [] },
          { id: "e99", description: "Nobody" },
        ],
      });
    };
    const first = await runCrawler(compendium.id);
    assert.equal(first.status, "done");
    const prompt = prompts.at(-1)!;
    assert.ok(!prompt.includes("Thorn Gate never opens"), "a locked entry isn't sent");
    assert.ok(prompt.indexOf("Syliveera") < prompt.indexOf("Unseelie Court rules"), "missing summary and tag first");
    assert.match(prompt, /targets: t\d+ Unseelie Court/, "the entry's mentions are its link targets");
    assert.ok(!/targets: [^\n]*Thorn Gate/.test(prompt), "an existing link isn't offered again");
    assert.equal(first.run!.entryCount, 2);
    assert.equal(first.run!.proposals, 2);
    assert.deepEqual(
      first.run!.skipped.map((item) => item.why).sort(),
      ["not a mentioned target", "unknown entry", 'unknown relation "represents"'].sort(),
    );

    const pending = (await listProposals(documents, "pending")).filter((p) => p.source === "crawler");
    const sylProposal = pending.find((p) => p.targetEntryId === "syliveera")!;
    assert.deepEqual(sylProposal.patch, {
      description: "A fae knight of the Unseelie Court.",
      tag: "character",
      addKeys: ["Syl", "Knight of Thorns"],
      addLinks: [{ key: "unseelie", relation: "member_of", name: "Unseelie Court" }],
    });
    // The Unseelie Court has no tag or summary yet: the Crawler fills both. Nothing touches its content.
    const courtProposal = pending.find((p) => p.targetEntryId === "unseelie")!;
    assert.deepEqual(courtProposal.patch, { description: "The night court of the fae.", tag: "faction" });

    // ── Tidied (seen, or waiting in Review): nothing left; Tidy entries says so and doesn't call the model. ──
    assert.equal(await countUntidied(compendium.id), 0);
    const calls = prompts.length;
    const empty = await runCrawler(compendium.id);
    assert.equal(empty.status, "nothing_to_do");
    assert.equal(prompts.length, calls);

    // ── Apply merges into the entry as it is now: a key and a link added meanwhile survive. ──
    (entry("syliveera").keys as string[]).push("Lady of Thorns");
    (entry("syliveera").relationships as Record<string, string>).unseelie = "leads";
    const applied = await applyProposal(runtime, sylProposal.id);
    assert.deepEqual(entry("syliveera").keys, ["Syliveera", "Lady of Thorns", "Syl", "Knight of Thorns"]);
    assert.deepEqual(entry("syliveera").relationships, { gate: "related_to", unseelie: "leads" }, "never replaces");
    assert.equal(entry("syliveera").description, "A fae knight of the Unseelie Court.");
    assert.equal(entry("syliveera").tag, "character");
    assert.ok(!("addKeys" in entry("syliveera")) && !("addLinks" in entry("syliveera")), "no raw patch fields");
    assert.deepEqual(applied.before, {
      description: "",
      tag: "",
      keys: ["Syliveera", "Lady of Thorns"],
      relationships: { gate: "related_to", unseelie: "leads" },
    });

    // ── A content change makes an entry untidied again, once nothing of the Crawler's waits for it. ──
    await dismissProposal(documents, courtProposal.id);
    assert.equal(await countUntidied(compendium.id), 0, "content unchanged: still tidied");
    entry("unseelie").content = "The Unseelie Court rules the night. Its queen is Mab.";
    assert.equal(await countUntidied(compendium.id), 1);

    // ── A failed run marks nothing tidied. ──
    answer = () => new Error("rate limited");
    const failed = await runCrawler(compendium.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.run!.detail, "rate limited");
    assert.equal(await countUntidied(compendium.id), 1);
    answer = () => "not json at all";
    assert.equal((await runCrawler(compendium.id)).status, "failed");
    assert.equal(await countUntidied(compendium.id), 1);

    // ── After an applied Archivist change: only that entry, in the background, with the chat's connection. ──
    await saveSettings(documents, { crawler: { trigger: "on_demand" } });
    const archived = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "syliveera",
      entryName: "Syliveera",
      patch: { newFacts: ["Syliveera now serves the Seelie Queen."] },
      source: "archivist",
      chatId: "chat-1",
    });
    const archivedApplied = await applyProposal(runtime, archived.id);
    assert.equal(await crawlAfterArchivist(archivedApplied), null, "on demand: no run after the Archivist");
    assert.equal(await countUntidied(compendium.id), 2, "the Archivist's fact made Syliveera untidied");

    await saveSettings(documents, { crawler: { trigger: "after_archivist" } });
    answer = (text) => JSON.stringify({ entries: [{ id: shortId(text, "Syliveera"), keys: ["Seelie Envoy"] }] });
    const after = await crawlAfterArchivist(archivedApplied);
    assert.equal(after?.status, "done");
    assert.equal(after!.run!.trigger, "after_archivist");
    assert.equal(after!.run!.entryCount, 1, "only the changed entry");
    assert.ok(!prompts.at(-1)!.includes("Its queen is Mab"), "the other untidied entry waits for Tidy entries");
    assert.equal(await countUntidied(compendium.id), 1);
    assert.equal(await crawlAfterArchivist({ ...archivedApplied, source: "crawler" }), null, "only Archivist changes");

    const runs = await listCrawlerRuns();
    assert.ok(runs.length >= 4 && runs[0]!.trigger === "after_archivist", "runs recorded, newest first");
    assert.ok(
      runs.every((run) => run.trigger === "manual" || run.status === "done"),
      "an after-Archivist run with nothing to do isn't recorded",
    );
  } finally {
    resetLiveClaims();
    release();
  }
}

main()
  .then(() => console.log("lorebook-manager-crawler.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
