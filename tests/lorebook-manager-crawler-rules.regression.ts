/**
 * Round 6 (Ylli, 2026-11-27): the Crawler's rules after the second live test. A summary is required where an entry
 * has none (an answer without one leaves the entry untidied, up to two tries); Redo last batch asks again; links go
 * to the closest rung of a ladder; part_of is a person's call; a broad key can be swapped for the full name; and Tidy
 * entries suggests whole words per lorebook without a model. A fake model host answers.
 * Run: npx tsx --tsconfig tests/tsconfig.regressions.json tests/lorebook-manager-crawler-rules.regression.ts
 */
import assert from "node:assert/strict";
import { createCompendium } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/compendiums-store.js";
import {
  CRAWLER_SYSTEM,
  countUntidied,
  redoLastCrawl,
  runCrawler,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/crawler.js";
import { resetLiveClaims } from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/live-claims.js";
import {
  applyProposal,
  dismissProposal,
  listProposals,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/proposals-store.js";
import {
  configureLorebookManagerRuntime,
  type LorebookManagerDocumentRecord,
  type LorebookManagerDocumentStore,
  type LorebookManagerRuntimeHost,
} from "../packages/lorebook-manager/src/engine/packages/server/src/services/lorebook-manager/package-runtime.js";
import {
  DEFAULT_ARCHIVIST_SETTINGS,
  DEFAULT_CRAWLER_SETTINGS,
} from "../packages/lorebook-manager/src/engine/packages/shared/src/features/agents/lorebook-manager/settings-helpers.js";

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

const off = { matchWholeWords: false };
const books = [
  {
    id: "ninja",
    data: { name: "Ninja World", category: "world" },
    entries: [
      {
        id: "jutsu",
        name: "Jutsu",
        keys: ["Jutsu"],
        description: "Ninja techniques.",
        tag: "concept",
        content: "Jutsu are the techniques of ninja.",
        ...off,
      },
      {
        id: "ninjutsu",
        name: "Ninjutsu",
        keys: ["Ninjutsu"],
        description: "Techniques moulded from chakra.",
        tag: "concept",
        content: "Ninjutsu is one kind of Jutsu.",
        relationships: { jutsu: "is_a" },
        ...off,
      },
      {
        id: "clone",
        name: "Shadow Clone Technique",
        keys: ["Shadow"],
        description: "",
        tag: "ability",
        content: "The Shadow Clone Technique is a Ninjutsu, so a Jutsu too, and the Sharingan can copy it.",
        relationships: { ninjutsu: "is_a" },
        ...off,
      },
      {
        id: "sharingan",
        name: "Sharingan",
        keys: ["Sharingan"],
        description: "An eye.",
        tag: "ability",
        content: "The Sharingan copies techniques.",
        matchWholeWords: true,
      },
      {
        id: "step",
        name: "Shadow Step",
        keys: ["Shadow", "Shadow Step"],
        description: "A quick step.",
        tag: "ability",
        content: "A step through shade.",
        ...off,
      },
      {
        id: "rasengan",
        name: "Rasengan",
        keys: ["螺旋丸"],
        description: "A spinning sphere.",
        tag: "ability",
        content: "A sphere of chakra.",
        ...off,
      },
      {
        id: "pattern",
        name: "Pattern",
        keys: ["sha.*"],
        useRegex: true,
        description: "A regex key.",
        tag: "concept",
        content: "Pattern.",
        ...off,
      },
    ] as Array<Record<string, unknown>>,
  },
];
const entry = (id: string) => books[0]!.entries.find((item) => item.id === id)!;

type Answer = (prompt: string) => string;

async function main() {
  assert.ok(!/part_of/.test(CRAWLER_SYSTEM), "part_of is a person's call (round 6)");
  assert.match(CRAWLER_SYSTEM, /description: REQUIRED/, "a missing summary is required, not optional");
  assert.match(CRAWLER_SYSTEM, /is_a: A kind, form or instance of/, "a form goes to is_a");
  assert.equal(DEFAULT_CRAWLER_SETTINGS.temperature, 0.7, "the Engine agents' default temperature");
  assert.equal(DEFAULT_ARCHIVIST_SETTINGS.temperature, 0.7);

  const documents = makeMemoryDocStore();
  const prompts: string[] = [];
  let answer: Answer = () => '{"entries": []}';
  const runtime: LorebookManagerRuntimeHost = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    persistence: { documents },
    languageModels: {
      async resolveForRequest(request) {
        return {
          connectionId: request.connectionId ?? "default",
          model: "fake-model",
          async chatComplete(chat) {
            const prompt = chat.find((m) => m.role === "user")?.content ?? "";
            prompts.push(prompt);
            return { content: answer(prompt), finishReason: "stop" };
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
        Object.assign(target, patch);
        return { id: entryId, lorebookId: "ninja", data: target };
      },
    },
  };
  const release = configureLorebookManagerRuntime(runtime);
  const shortId = (prompt: string, name: string) => new RegExp(`\\[(e\\d+)\\] ${name}\\n`).exec(prompt)?.[1] ?? "e?";
  const target = (prompt: string, name: string) => new RegExp(`(t\\d+) ${name}(?:;|\\n)`).exec(prompt)?.[1] ?? "t?";
  // Every other entry has its summary and needs nothing: answered with its id alone.
  const rest = (prompt: string, ...skip: string[]) =>
    [...prompt.matchAll(/\[(e\d+)\] ([^\n]+)\n/g)].filter((m) => !skip.includes(m[2]!)).map((m) => ({ id: m[1] }));
  try {
    const compendium = await createCompendium(documents, { name: "Ninja", lorebookIds: ["ninja"] });

    // ── Run 1: no summary for the clone; a key swap; a ladder link above an existing rung; part_of refused. ──
    answer = (prompt) =>
      JSON.stringify({
        entries: [
          {
            id: shortId(prompt, "Shadow Clone Technique"),
            removeKeys: ["Shadow"],
            addKeys: ["Shadow Clone Technique"],
            links: [
              { to: target(prompt, "Jutsu"), relation: "is_a" },
              { to: target(prompt, "Sharingan"), relation: "part_of" },
            ],
          },
          { id: shortId(prompt, "Sharingan"), removeKeys: ["Sharingan"] },
          { id: shortId(prompt, "Rasengan"), removeKeys: ["螺旋丸"] },
          ...rest(prompt, "Shadow Clone Technique", "Sharingan", "Rasengan"),
        ],
      });
    const first = await runCrawler(compendium.id);
    assert.equal(first.status, "done");
    const prompt = prompts.at(-1)!;
    assert.match(prompt, /keys: Shadow \(also a key of 1 other entry\)/, "a shared key says so");
    assert.match(prompt, /keys: Shadow \(also a key of 1 other entry\), Shadow Step/);
    assert.deepEqual(first.run!.entryIds?.length, 7, "the run keeps its entries for Redo");
    const skipped = first.run!.skipped.map((item) => `${item.name}: ${item.why}`);
    assert.ok(skipped.includes("Shadow Clone Technique → Jutsu: already under Ninjutsu"), skipped.join(" | "));
    assert.ok(
      skipped.some((line) => line.includes('unknown relation "part_of"')),
      "part_of is refused",
    );
    assert.ok(skipped.includes("Shadow Clone Technique: no summary; asked again next run"));
    let pending = await listProposals(documents, "pending");
    const clone = pending.find((proposal) => proposal.targetEntryId === "clone")!;
    assert.deepEqual(
      clone.patch,
      { addKeys: ["Shadow Clone Technique"], removeKeys: ["Shadow"] },
      "the swap may replace the only key; no ladder or part_of link",
    );
    assert.ok(!pending.some((proposal) => proposal.targetEntryId === "sharingan"), "never the own name");
    assert.ok(!pending.some((proposal) => proposal.targetEntryId === "rasengan"), "the last key stays without a swap");

    // Whole words: one card for the book, without the model; not for a CJK key, a regex key or an entry that has it.
    const book = pending.find((proposal) => proposal.kind === "update_book")!;
    assert.equal(book.entryName, "Ninja World");
    assert.deepEqual(
      (book.patch.wholeWords as Array<{ id: string }>).map((item) => item.id),
      ["jutsu", "ninjutsu", "clone", "step"],
    );
    assert.match(first.run!.detail ?? "", /Whole words: a suggestion for 4 entries waits in Review/);

    // ── Dismissed, the clone comes back (no summary yet); the second try without one gives up. ──
    assert.equal(await countUntidied(compendium.id), 0, "the clone waits on its suggestion");
    await dismissProposal(documents, clone.id);
    assert.equal(await countUntidied(compendium.id), 1, "tried once without a summary: untidied");
    answer = (p) => JSON.stringify({ entries: [{ id: shortId(p, "Shadow Clone Technique") }] });
    const second = await runCrawler(compendium.id);
    assert.equal(second.run!.entryCount, 1);
    assert.ok(second.run!.skipped.some((item) => item.why === "no summary after 2 tries"));
    assert.equal(await countUntidied(compendium.id), 0, "given up after two tries");
    pending = await listProposals(documents, "pending");
    assert.equal(pending.filter((proposal) => proposal.kind === "update_book").length, 1, "whole words asked once");

    // ── Redo last batch: asks again about the clone, and this time it answers. ──
    answer = (p) =>
      JSON.stringify({
        entries: [
          {
            id: shortId(p, "Shadow Clone Technique"),
            description: "A Ninjutsu that makes solid copies of the user.",
            removeKeys: ["Shadow"],
            addKeys: ["Shadow Clone Technique"],
          },
        ],
      });
    const redo = await redoLastCrawl(compendium.id);
    assert.equal(redo.status, "done");
    assert.equal(redo.run!.trigger, "redo");
    assert.deepEqual(redo.run!.entryIds, ["clone"]);
    const answered = (await listProposals(documents, "pending")).find(
      (proposal) => proposal.targetEntryId === "clone",
    )!;
    await applyProposal(runtime, answered.id);
    assert.equal(entry("clone").description, "A Ninjutsu that makes solid copies of the user.");
    assert.deepEqual(entry("clone").keys, ["Shadow Clone Technique"], "Shadow swapped for the full name");
    const nothing = await redoLastCrawl(compendium.id);
    assert.equal(nothing.status, "nothing_to_do");
    assert.equal(nothing.detail, "Every suggestion from the last batch was applied");

    // A pending suggestion from the batch is dismissed by Redo.
    answer = (p) => JSON.stringify({ entries: [{ id: shortId(p, "Shadow Clone Technique"), description: "Again." }] });
    // An edit untidies the clone (its summary is gone again); Tidy entries suggests one, which waits.
    entry("clone").description = "";
    entry("clone").content = `${String(entry("clone").content)} It fades when struck.`;
    await runCrawler(compendium.id);
    const waiting = (await listProposals(documents, "pending")).find((proposal) => proposal.targetEntryId === "clone")!;
    assert.equal(waiting.patch.description, "Again.");
    answer = (p) => JSON.stringify({ entries: [{ id: shortId(p, "Shadow Clone Technique"), description: "Third." }] });
    await redoLastCrawl(compendium.id);
    const redone = await listProposals(documents);
    assert.equal(redone.find((proposal) => proposal.id === waiting.id)!.status, "dismissed", "Redo dismissed it");
    assert.equal(
      redone.find((proposal) => proposal.status === "pending" && proposal.targetEntryId === "clone")!.patch.description,
      "Third.",
    );

    // ── The whole-words card, trimmed in Review: only the kept entries change. ──
    const applied = await applyProposal(runtime, book.id, {
      wholeWords: [{ id: "jutsu" }, { id: "ninjutsu" }, { id: "nope" }],
    });
    assert.equal(entry("jutsu").matchWholeWords, true);
    assert.equal(entry("ninjutsu").matchWholeWords, true);
    assert.equal(entry("step").matchWholeWords, false, "left out in Review");
    assert.deepEqual(
      (applied.patch.wholeWords as Array<{ id: string }>).map((item) => item.id),
      ["jutsu", "ninjutsu"],
    );
    assert.deepEqual(applied.before, { jutsu: { matchWholeWords: false }, ninjutsu: { matchWholeWords: false } });
    assert.deepEqual(
      (applied.patch.leftOut as Array<{ id: string }>).map((item) => item.id),
      ["clone", "step"],
      "what you left out is kept apart",
    );
    entry("jutsu").content = "Jutsu are the techniques of ninja and samurai.";
    await runCrawler(compendium.id);
    assert.equal(
      (await listProposals(documents)).filter((proposal) => proposal.kind === "update_book").length,
      1,
      "an entry on an earlier card isn't listed again",
    );
  } finally {
    resetLiveClaims();
    release();
  }
}

main()
  .then(() => console.log("lorebook-manager-crawler-rules.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
