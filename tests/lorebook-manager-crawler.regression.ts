/**
 * B2a: the Crawler (Tidy entries). One model call per batch fills in a missing summary and tag, adds keywords and
 * links to mentioned entries; suggestions go to Review and merge into the entry as it is at Apply. A fake model host
 * answers; no model is called for real.
 * Run: npx tsx --tsconfig tests/tsconfig.regressions.json tests/lorebook-manager-crawler.regression.ts
 */
import assert from "node:assert/strict";
import { createCompendium } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  CRAWLER_LINKS_SYSTEM,
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
        tag: "faction",
        content: "The Unseelie Court rules the night.",
      },
      {
        id: "syliveera",
        name: "Syliveera",
        keys: ["Syliveera", "Thorns"],
        constant: true,
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
  for (const system of [CRAWLER_SYSTEM, CRAWLER_LINKS_SYSTEM]) {
    assert.ok(!system.includes("represents"), "the Crawler never writes represents links");
    assert.ok(!system.includes("related_to"), "the Crawler never writes related_to links (round 5)");
  }
  assert.match(CRAWLER_LINKS_SYSTEM, /member_of: Belongs to a group/, "each relation comes with the UI's hint");
  assert.ok(!/member_of|links/.test(CRAWLER_SYSTEM), "links have their own call (round 3)");

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
  const isLinks = (prompt: string) => prompt.includes("\ntargets:\n");
  const tidyPrompt = () => prompts.filter((p) => !isLinks(p)).at(-1)!;
  const linksPrompt = () => prompts.filter(isLinks).at(-1)!;
  try {
    const compendium = await createCompendium(documents, { name: "Fae", lorebookIds: ["court"] });

    // ── Locked entries are never tidied; the rest wait. ──
    assert.equal(await countUntidied(compendium.id), 2);

    // ── A batch: gaps first, targets from mentions, unknown ids / targets / relations left out. ──
    answer = (prompt) => {
      const syl = shortId(prompt, "Syliveera");
      const court = shortId(prompt, "Unseelie Court");
      const target = /- (t\d+) Unseelie Court/.exec(prompt)?.[1] ?? "t?";
      return JSON.stringify({
        entries: [
          {
            id: syl,
            description: "A fae knight of the Unseelie Court.",
            tag: "Character",
            keys: ["Syl", "syliveera", "Knight of Thorns", "Lady Syl"],
            removeKeys: ["thorns", "Syliveera", "Nonexistent"],
            constant: false,
            links: [
              { to: target, relation: "member_of" },
              { to: "t99", relation: "ally_of" },
              { to: target, relation: "represents" },
              { to: target, relation: "related_to" },
            ],
          },
          { id: court, description: "The night court of the fae.", tag: "faction", keys: [] },
          { id: "e99", description: "Nobody" },
        ],
      });
    };
    const first = await runCrawler(compendium.id);
    assert.equal(first.status, "done");
    const prompt = tidyPrompt();
    const links = linksPrompt();
    assert.equal(prompts.length, 2, "one call for summaries and keys, one for links");
    assert.ok(!prompt.includes("Thorn Gate never opens"), "a locked entry isn't sent");
    assert.ok(!links.includes("Thorn Gate never opens"), "a locked entry isn't sent");
    assert.ok(prompt.indexOf("Syliveera") < prompt.indexOf("Unseelie Court rules"), "missing summary and tag first");
    assert.ok(!prompt.includes("targets:"), "the first call has no link targets");
    assert.match(prompt, /\[e1\] Syliveera\n[^[]*links: \(none\)/, "a related_to link isn't shown (round 3)");
    assert.match(
      links,
      /targets:\n- t\d+ Unseelie Court \(faction\): The night court of the fae\./,
      "the entry's mentions are its link targets, each with its summary (a fresh one from the first call too)",
    );
    assert.match(links, /\[e1\] Syliveera\ndescription: A fae knight of the Unseelie Court\./, "the new summary");
    assert.ok(!/- t\d+ Thorn Gate/.test(links), "an existing link isn't offered again");
    assert.ok(!links.includes("[e2] Unseelie Court"), "an entry without targets isn't in the links call");
    assert.equal(first.run!.entryCount, 2);
    assert.equal(first.run!.proposals, 2);
    assert.deepEqual(
      first.run!.skipped.map((item) => item.why).sort(),
      ["not a listed target", "unknown entry", 'unknown relation "represents"', 'unknown relation "related_to"'].sort(),
    );

    const pending = (await listProposals(documents, "pending")).filter((p) => p.source === "crawler");
    const sylProposal = pending.find((p) => p.targetEntryId === "syliveera")!;
    assert.ok(prompt.includes("always on: yes"), "a constant entry says so");
    assert.deepEqual(
      sylProposal.patch,
      {
        description: "A fae knight of the Unseelie Court.",
        tag: "character",
        removeKeys: ["Thorns"],
        constant: false,
        addKeys: ["Syl", "Knight of Thorns"],
        addLinks: [{ key: "unseelie", relation: "member_of", name: "Unseelie Court" }],
      },
      "at most 2 keys; the own name and unknown keys are never removed; related_to is refused",
    );
    // The Unseelie Court has a tag but no summary: the Crawler fills only the summary. Nothing touches its content.
    const courtProposal = pending.find((p) => p.targetEntryId === "unseelie")!;
    assert.deepEqual(courtProposal.patch, { description: "The night court of the fae." }, "its tag is set already");

    // ── Tidied (seen, or waiting in Review): nothing left; Tidy entries says so and doesn't call the model. ──
    assert.equal(await countUntidied(compendium.id), 0);
    const calls = prompts.length;
    const empty = await runCrawler(compendium.id);
    assert.equal(empty.status, "nothing_to_do");
    assert.equal(prompts.length, calls);

    // ── Apply merges into the entry as it is now: a key and a link added meanwhile survive. ──
    // Trimmed in Review: one key and the summary left out, the tag reworded. The edit can't add a key or a link.
    (entry("syliveera").keys as string[]).push("Lady of Thorns");
    (entry("syliveera").relationships as Record<string, string>).unseelie = "leads";
    const applied = await applyProposal(runtime, sylProposal.id, {
      tag: "Knight",
      removeKeys: ["Thorns"],
      constant: false,
      addKeys: ["Syl", "Invented Key"],
      addLinks: [
        { key: "unseelie", relation: "leads", name: "Unseelie Court" },
        { key: "gate", relation: "member_of", name: "Thorn Gate" },
      ],
    });
    assert.deepEqual(
      applied.patch,
      {
        tag: "knight",
        removeKeys: ["Thorns"],
        constant: false,
        addKeys: ["Syl"],
        addLinks: [{ key: "unseelie", relation: "leads", name: "Unseelie Court" }],
      },
      "the applied suggestion keeps the trimmed version",
    );
    assert.deepEqual(entry("syliveera").keys, ["Syliveera", "Lady of Thorns", "Syl"], "Thorns out, Syl in");
    assert.equal(entry("syliveera").constant, false);
    assert.deepEqual(entry("syliveera").relationships, { gate: "related_to", unseelie: "leads" }, "never replaces");
    assert.equal(entry("syliveera").description, "", "a left-out summary isn't written");
    assert.equal(entry("syliveera").tag, "knight");
    assert.ok(
      !["addKeys", "addLinks", "removeKeys"].some((field) => field in entry("syliveera")),
      "no raw patch fields",
    );
    assert.deepEqual(applied.before, {
      tag: "",
      constant: true,
      keys: ["Syliveera", "Thorns", "Lady of Thorns"],
      relationships: { gate: "related_to", unseelie: "leads" },
    });
    await assert.rejects(
      applyProposal(runtime, courtProposal.id, { addKeys: ["Unseelie"] }),
      /Nothing is left to apply/,
      "an edit that leaves nothing is refused",
    );
    await assert.rejects(
      applyProposal(runtime, courtProposal.id, { description: "Edited." }, courtProposal.revision + 1),
      /changed while you edited/,
      "an edit made on an older version is refused, not cut",
    );

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
    assert.equal(
      await crawlAfterArchivist(archivedApplied, { waitMs: 0 }),
      null,
      "on demand: no run after the Archivist",
    );
    assert.equal(await countUntidied(compendium.id), 2, "the Archivist's fact made Syliveera untidied");

    await saveSettings(documents, { crawler: { trigger: "after_archivist" } });
    answer = (text) => JSON.stringify({ entries: [{ id: shortId(text, "Syliveera"), keys: ["Seelie Envoy"] }] });
    const after = await crawlAfterArchivist(archivedApplied, { waitMs: 0 });
    assert.equal(after?.status, "done");
    assert.equal(after!.run!.trigger, "after_archivist");
    assert.equal(after!.run!.entryCount, 1, "only the changed entry");
    assert.ok(!prompts.at(-1)!.includes("Its queen is Mab"), "the other untidied entry waits for Tidy entries");
    assert.equal(await countUntidied(compendium.id), 1);
    assert.equal(
      await crawlAfterArchivist({ ...archivedApplied, source: "crawler" }, { waitMs: 0 }),
      null,
      "only Archivist changes",
    );

    // ── An entry the model leaves out stays untidied for the next run. ──
    answer = () => '{"entries": []}';
    const leftOut = await runCrawler(compendium.id);
    assert.equal(leftOut.status, "done");
    assert.ok(leftOut.run!.skipped.some((item) => item.why.startsWith("not answered")));
    assert.equal(leftOut.run!.remaining, 1);
    assert.equal(await countUntidied(compendium.id), 1);

    // ── A summary written while the suggestion waited stays; the blank tag is filled. ──
    answer = (text) =>
      JSON.stringify({
        entries: [{ id: shortId(text, "Unseelie Court"), description: "Fae night court.", tag: "faction" }],
      });
    await runCrawler(compendium.id);
    const courtAgain = (await listProposals(documents, "pending")).find(
      (p) => p.source === "crawler" && p.targetEntryId === "unseelie",
    )!;
    entry("unseelie").description = "Written by hand.";
    await applyProposal(runtime, courtAgain.id);
    assert.equal(entry("unseelie").description, "Written by hand.");
    assert.equal(entry("unseelie").tag, "faction");

    // ── Applies close together share one run: clicking through Review's stack is one call. ──
    for (const waiting of (await listProposals(documents, "pending")).filter((p) => p.source === "crawler")) {
      await dismissProposal(documents, waiting.id);
    }
    entry("syliveera").content = "Syliveera serves the Seelie Queen now.";
    entry("unseelie").content = "The Unseelie Court rules the night. Mab is gone.";
    const callsBefore = prompts.length;
    answer = () => '{"entries": []}';
    const [firstApply, secondApply] = await Promise.all([
      crawlAfterArchivist(archivedApplied, { waitMs: 30 }),
      crawlAfterArchivist(
        { ...archivedApplied, appliedEntryId: "unseelie", targetEntryId: "unseelie" },
        { waitMs: 30 },
      ),
    ]);
    assert.equal(prompts.length, callsBefore + 1, "one model call for both");
    assert.equal(firstApply, secondApply, "both Applies share the run");
    assert.equal(firstApply!.run!.entryCount, 2);

    // ── Apply checks removals again: never the entry's current name. ──
    const strip = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: "court",
      targetEntryId: "syliveera",
      entryName: "Syliveera",
      patch: { removeKeys: [...(entry("syliveera").keys as string[])] },
      source: "crawler",
    });
    await applyProposal(runtime, strip.id);
    assert.deepEqual(entry("syliveera").keys, ["Syliveera"], "the entry's own name stays a key");

    // ── A failed links call keeps the first call's suggestions and says so. ──
    for (const waiting of (await listProposals(documents, "pending")).filter((p) => p.source === "crawler")) {
      await dismissProposal(documents, waiting.id);
    }
    entry("unseelie").content = "The Unseelie Court rules the night beyond the Thorn Gate.";
    answer = (text) =>
      isLinks(text)
        ? "not json"
        : JSON.stringify({ entries: [{ id: shortId(text, "Unseelie Court"), addKeys: ["Night Court"] }] });
    const linksFailed = await runCrawler(compendium.id);
    assert.equal(linksFailed.status, "done");
    assert.ok(
      linksFailed.run!.skipped.some(
        (item) => item.name === "Links" && item.why === "not checked: The model's answer wasn't readable",
      ),
      "the failed links call is named",
    );
    const keysKept = (await listProposals(documents, "pending")).find(
      (p) => p.source === "crawler" && p.targetEntryId === "unseelie",
    )!;
    assert.deepEqual(keysKept.patch, { addKeys: ["Night Court"] }, "the keys stand without the links");

    const runs = await listCrawlerRuns();
    assert.ok(runs.length >= 6 && runs.some((run) => run.trigger === "after_archivist"), "runs recorded");
    assert.ok(runs[0]!.at >= runs.at(-1)!.at, "newest first");
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
