import {
  parseEntityRef,
  toRelationshipKey,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import { LM_RELATIONS } from "../../../../shared/src/features/agents/lorebook-manager/relations.js";
import type {
  LmCompendium,
  LmCrawlerRunRecord,
  LmCrawlerRunStatus,
  LmEntityNode,
  LmEntryNode,
  LmGraphPayload,
  LmProposal,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { backgroundModelSignal, runInBackgroundQueue } from "./archivist.js";
import { getCompendium, listCompendiums, LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { compendiumForChat } from "./live-claims.js";
import { getLorebookManagerRuntime, type LorebookManagerDocumentStore } from "./package-runtime.js";
import { comparableFact, createProposal, dismissProposal, listProposals } from "./proposals-store.js";
import { buildLorebookManagerGraphPayload } from "./routes.js";
import { getSettings } from "./settings-store.js";

// ── The Crawler (Tidy entries): one model call per batch fills in what an entry is missing. ──
// Phase 1 suggests a summary and a tag where an entry has none, keyword fixes (a needed alias, a too-broad key out),
// "always on" off where it doesn't belong, and specific links to the entries and cards its text mentions. Facets
// (dynamicState) come later. Everything goes to Review, one suggestion per entry.
// An entry counts as tidied once the model has seen it with its current name and content; editing either (an
// applied Archivist fact, a hand edit) queues it again.

const CONTENT_CHARS = 1_500;
const MAX_LINK_TARGETS = 12;
const MAX_TARGETS = 200;
// Every added key is a trusted match: few, and only names the story uses (Ylli's round 5: "red-haired shinobi").
const MAX_KEYS_ADDED = 2;
const MAX_KEYS_TOTAL = 12;
const MAX_LINKS_ADDED = 3;
const DESCRIPTION_CHARS = 240;
const TAG_CHARS = 40;
const MAX_RECORDED_RUNS = 20;

export const CRAWLER_RUN_DOC_KIND = "crawler_run";
export const CRAWLER_STATE_DOC_KIND = "crawler_state";

/**
 * Relations the Crawler may write: the specific ones. `related_to` says nothing a mention doesn't, and the Crawler
 * spammed it to everything an entry names (Ylli's round 5); a person can still add it. `represents` hides an entry
 * while its card is active: a person's call too. `part_of` pulls hardest, both ways, and is meant for a section split
 * off the same subject; the model used it for "a form of" and "belongs to" (round 6), so only a person writes it.
 */
const CRAWLER_RELATION_DEFS = LM_RELATIONS.filter(
  (relation) => !["related_to", "represents", "part_of"].includes(relation.value),
);
const CRAWLER_RELATIONS = CRAWLER_RELATION_DEFS.map((relation) => relation.value);
/** Relations that form a ladder: a link goes to the closest rung, never one the entry already reaches through it. */
const LADDER_RELATIONS = new Set(["is_a", "member_of", "located_in"]);
/** Tries for a summary before an entry is left as it is, so a model that keeps skipping one can't hold the queue. */
const MAX_SUMMARY_TRIES = 2;
/** Scripts with no spaces between words: whole words would stop such a key from matching inside a sentence. */
const NO_WORD_GAPS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const AFTER_ARCHIVIST_WAIT_MS = 20_000;
/** A steady stream of Applies can't hold the run back longer than this after the first one. */
const AFTER_ARCHIVIST_MAX_WAITS = 3;

const stateDocId = (compendiumId: string) => `crawler_state:${compendiumId}`;
const runDocId = (compendiumId: string) => `crawler_run:${compendiumId}`;

/**
 * Bumped when the Crawler's rules change enough to look again: every entry is untidied once (2: round 5's prompt, with
 * key removal, "always on" and no related_to; 3: round 6, summaries required, no part_of, key swaps). Costs nothing
 * until Tidy entries runs.
 */
const CRAWLER_RULES_VERSION = 3;

/** What the model read of an entry: its name and content, under these rules. A change to either untidies it again. */
export function crawlHash(entry: Pick<LmEntryNode, "name" | "content">): string {
  const text = `${CRAWLER_RULES_VERSION}\n${entry.name}\n${entry.content}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

interface CrawlerState {
  crawled: Record<string, string>;
  /** Runs that looked at an entry without tidying it (no summary, or left out of the answer). */
  attempts: Record<string, number>;
}

async function readState(
  documents: LorebookManagerDocumentStore,
  compendiumId: string,
): Promise<{ state: CrawlerState; revision: number | null }> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, stateDocId(compendiumId));
  const data = (doc?.data ?? {}) as { crawled?: unknown; attempts?: unknown };
  const crawled: Record<string, string> = {};
  const attempts: Record<string, number> = {};
  if (data.crawled && typeof data.crawled === "object" && !Array.isArray(data.crawled)) {
    for (const [id, hash] of Object.entries(data.crawled as Record<string, unknown>)) {
      if (typeof hash === "string") crawled[id] = hash;
    }
  }
  if (data.attempts && typeof data.attempts === "object" && !Array.isArray(data.attempts)) {
    for (const [id, count] of Object.entries(data.attempts as Record<string, unknown>)) {
      if (typeof count === "number" && count > 0) attempts[id] = count;
    }
  }
  return { state: { crawled, attempts }, revision: doc ? doc.revision : null };
}

/** Tidied entries are marked with what the model read; tried ones count a try; untidied ones start over. */
async function saveCrawlState(
  documents: LorebookManagerDocumentStore,
  compendiumId: string,
  change: { tidied?: readonly LmEntryNode[]; tried?: readonly LmEntryNode[]; untidy?: readonly string[] },
): Promise<void> {
  const { state, revision } = await readState(documents, compendiumId);
  const crawled = { ...state.crawled };
  const attempts = { ...state.attempts };
  for (const entry of change.tidied ?? []) {
    crawled[entry.id] = crawlHash(entry);
    delete attempts[entry.id];
  }
  for (const entry of change.tried ?? []) attempts[entry.id] = (attempts[entry.id] ?? 0) + 1;
  for (const id of change.untidy ?? []) {
    delete crawled[id];
    delete attempts[id];
  }
  const now = new Date().toISOString();
  const data = { compendiumId, crawled, attempts };
  if (revision === null) {
    await documents.create({
      id: stateDocId(compendiumId),
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: CRAWLER_STATE_DOC_KIND,
      name: `Crawler state for Compendium ${compendiumId}`,
      description: "",
      data,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  await documents.update({
    id: stateDocId(compendiumId),
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: revision,
    name: `Crawler state for Compendium ${compendiumId}`,
    description: "",
    data,
    updatedAt: now,
  });
}

async function recordRun(documents: LorebookManagerDocumentStore, record: LmCrawlerRunRecord): Promise<void> {
  // Best effort, like the retrieval runs: a failed Activity write never changes the run's outcome.
  try {
    await writeRun(documents, record);
  } catch (error) {
    getLorebookManagerRuntime().logger.warn("[lorebook-manager] Could not record a run: %s", error);
  }
}

async function writeRun(documents: LorebookManagerDocumentStore, record: LmCrawlerRunRecord): Promise<void> {
  const id = runDocId(record.compendiumId);
  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  const previous = Array.isArray((existing?.data as { runs?: unknown } | undefined)?.runs)
    ? ((existing!.data as { runs: LmCrawlerRunRecord[] }).runs ?? [])
    : [];
  const runs = [record, ...previous].slice(0, MAX_RECORDED_RUNS);
  const data = { compendiumId: record.compendiumId, runs };
  if (!existing) {
    await documents.create({
      id,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: CRAWLER_RUN_DOC_KIND,
      name: `Compendium ${record.compendiumId} Crawler runs`,
      description: "",
      data,
      createdAt: record.at,
      updatedAt: record.at,
    });
    return;
  }
  await documents.update({
    id,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: existing.revision,
    name: existing.name,
    description: "",
    data,
    updatedAt: record.at,
  });
}

export async function listCrawlerRuns(): Promise<LmCrawlerRunRecord[]> {
  const documents = getLorebookManagerRuntime().persistence.documents;
  const docs = await documents.list(LOREBOOK_MANAGER_PACKAGE_ID, CRAWLER_RUN_DOC_KIND);
  return docs
    .flatMap((doc) => {
      const runs = (doc.data as { runs?: unknown } | undefined)?.runs;
      return Array.isArray(runs) ? (runs as LmCrawlerRunRecord[]) : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ── Selection ──

async function compendiumGraph(compendium: LmCompendium, withMentions: boolean): Promise<LmGraphPayload> {
  return buildLorebookManagerGraphPayload({
    lorebookIds: new Set(compendium.lorebookIds),
    characterIds: new Set(compendium.characterIds),
    personaIds: new Set(compendium.personaIds),
    onlyRequested: true,
    skipMentions: !withMentions,
  });
}

/** The entry's gaps first (no summary, no tag, few keys), then book order. */
function gapScore(entry: LmEntryNode): number {
  return (entry.description.trim() ? 0 : 4) + (entry.tag.trim() ? 0 : 2) + (entry.keys.length < 2 ? 1 : 0);
}

/**
 * Entries the Crawler may still tidy: unlocked, changed since it last looked, no Crawler suggestion waiting. Entries
 * already tried come last, so a model that keeps skipping one summary can't hold the rest back.
 */
function untidied(
  payload: LmGraphPayload,
  compendium: LmCompendium,
  state: CrawlerState,
  pending: readonly LmProposal[],
): LmEntryNode[] {
  const books = new Set(compendium.lorebookIds);
  const waiting = new Set(
    pending.filter((proposal) => proposal.source === "crawler").map((proposal) => proposal.targetEntryId),
  );
  const tries = (entry: LmEntryNode) => state.attempts[entry.id] ?? 0;
  return payload.nodes
    .filter((node): node is LmEntryNode => node.nodeType === "lore" && books.has(node.lorebookId))
    .filter((entry) => !entry.locked && !waiting.has(entry.id) && state.crawled[entry.id] !== crawlHash(entry))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => tries(a.entry) - tries(b.entry) || gapScore(b.entry) - gapScore(a.entry) || a.index - b.index)
    .map((item) => item.entry);
}

/** How many entries Tidy entries would still look at in this Compendium. */
export async function countUntidied(compendiumId: string): Promise<number> {
  const documents = getLorebookManagerRuntime().persistence.documents;
  const compendium = await getCompendium(documents, compendiumId);
  if (!compendium || compendium.lorebookIds.length === 0) return 0;
  const [payload, { state }, pending] = await Promise.all([
    compendiumGraph(compendium, false),
    readState(documents, compendiumId),
    listProposals(documents, "pending"),
  ]);
  return untidied(payload, compendium, state, pending).length;
}

// ── The prompt ──

export const CRAWLER_SYSTEM = [
  "You tidy a roleplay's lorebook so the right entries come up during play. Every entry in <entries> gets an answer.",
  "",
  "description: REQUIRED for every entry whose description says (none): one plain sentence saying what the entry is",
  "(who, what or where), from its text. It is the most important field; never skip it for such an entry. Leave it",
  "out only where the entry has one already.",
  "tag: one or two lowercase words for its kind (character, location, item, faction, species, ability, event,",
  "concept, ...). Only if the entry has none.",
  "",
  "Everything else: only what is clearly missing or wrong. Most entries need few or no keyword and link changes.",
  "",
  "Keywords bring an entry into the story whenever one appears in the chat, without any further check. So:",
  "addKeys: at most 2 names or aliases the story really calls it by and the entry lacks. Never descriptions",
  '("red-haired shinobi"), titles of other things, or generic phrases.',
  "removeKeys: keys the entry already has that are too broad on their own: a common word that would bring it in for",
  'unrelated text ("Ten" for Ten-Tails, "Team" for Team Guy, "Dark", "water"), or one word of a longer name ("Shadow"',
  'for Shadow Clone Technique). A key marked "also a key of N other entries" is a strong sign. Copy them exactly.',
  "Never the entry's own name. To replace an entry's only key, put the better one in addKeys.",
  'constant: false, only for an entry marked "always on: yes" that isn\'t lore every scene needs (a person, place or',
  "event that matters only when it comes up).",
  "",
  "links: a link is a lasting fact about how the entry relates to a target; when the entry comes up, the link brings",
  'the target along. It reads "<entry> <relation> <target>". Only these relations:',
  ...CRAWLER_RELATION_DEFS.map((relation) => `- ${relation.value}: ${relation.hint}`),
  "Link only when the relation is plainly true from the entry's text. Naming, mentioning or comparing a target is",
  "not a link: an encounter prompt that names three teams links to none of them. Link to the closest kind, group or",
  "place only: an entry that is_a Ninjutsu gets no is_a Jutsu as well. Something that belongs to someone (a",
  "bloodline, a weapon) gets no link to its owner; the owner's own entry links to it with owns. At most 3 links per",
  "entry, only to targets listed under that entry. When no relation above fits exactly, leave the link out.",
  "",
  "Never invent keys or links; leave them out when unsure. An entry that has a description and needs nothing else is",
  'just {"id": "e2"}. Answer with JSON only:',
  '{"entries": [{"id": "e1", "description": "...", "tag": "...", "addKeys": ["..."], "removeKeys": ["..."],',
  '"constant": false, "links": [{"to": "t3", "relation": "member_of"}]}]}',
].join("\n");

function displayName(node: LmEntryNode | LmEntityNode): string {
  return node.nodeType === "lore" ? node.name : `${node.name} (${node.nodeType === "persona" ? "persona" : "card"})`;
}

export function crawlerUserPrompt(
  batch: readonly LmEntryNode[],
  linkTargets: ReadonlyMap<string, ReadonlyArray<{ shortId: string; node: LmEntryNode | LmEntityNode }>>,
  nameOf: (ref: string) => string,
  /** How many entries in the Compendium have each key (compared loosely): a shared key is a broad one. */
  keyUse: ReadonlyMap<string, number> = new Map(),
): string {
  const blocks = batch.map((entry, index) => {
    const content = entry.content.length > CONTENT_CHARS ? `${entry.content.slice(0, CONTENT_CHARS)}…` : entry.content;
    const links = Object.entries(entry.relationships)
      .map(([target, relation]) => `${relation} ${nameOf(target)}`)
      .join(", ");
    const targets = (linkTargets.get(entry.ref) ?? []).map((item) => `${item.shortId} ${displayName(item.node)}`);
    const keys = entry.keys.map((key) => {
      const others = (keyUse.get(comparableFact(key)) ?? 1) - 1;
      return others > 0 ? `${key} (also a key of ${others} other ${others === 1 ? "entry" : "entries"})` : key;
    });
    return [
      `[e${index + 1}] ${entry.name}`,
      `description: ${entry.description.trim() || "(none)"}`,
      `tag: ${entry.tag.trim() || "(none)"}`,
      `keys: ${keys.join(", ") || "(none)"}`,
      ...(entry.constant ? ["always on: yes"] : []),
      `links: ${links || "(none)"}`,
      `targets: ${targets.join("; ") || "(none)"}`,
      content.trim(),
    ].join("\n");
  });
  return `<entries>\n${blocks.join("\n\n")}\n</entries>`;
}

function safeParse(raw: string): unknown {
  const json = getLorebookManagerRuntime().json;
  try {
    return json ? json.parseJsonish(raw) : JSON.parse(raw);
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";

/** A link the Crawler suggests; `key` is what `entry.relationships` stores, `name` is for Review. */
export interface CrawlerLink {
  key: string;
  relation: string;
  name: string;
}

/**
 * Whole words on, one card per lorebook listing its entries that have it off (the Engine's default). No model: "Ame"
 * matching inside "game" is a setting, not a judgement (Ylli's round 6). An entry listed on an earlier card (applied,
 * dismissed or waiting) isn't listed again, nor one with regex keys or a key in a script without spaces.
 */
async function suggestWholeWords(
  documents: LorebookManagerDocumentStore,
  payload: LmGraphPayload,
  compendium: LmCompendium,
): Promise<number> {
  const listed = new Set(
    (await listProposals(documents))
      .filter((proposal) => proposal.kind === "update_book")
      .flatMap((proposal) =>
        [proposal.patch.wholeWords, proposal.patch.leftOut].flatMap((list) => (Array.isArray(list) ? list : [])),
      )
      .map((item) => asRecord(item).id)
      .filter((id): id is string => typeof id === "string"),
  );
  let count = 0;
  for (const lorebookId of compendium.lorebookIds) {
    const entries = payload.nodes.filter(
      (node): node is LmEntryNode =>
        node.nodeType === "lore" &&
        node.lorebookId === lorebookId &&
        !node.matchWholeWords &&
        !node.useRegex &&
        !node.locked &&
        node.keys.length > 0 &&
        !node.keys.some((key) => NO_WORD_GAPS.test(key)) &&
        !listed.has(node.id),
    );
    if (entries.length === 0) continue;
    await createProposal(documents, {
      kind: "update_book",
      lorebookId,
      entryName: payload.lorebooks.find((book) => book.id === lorebookId)?.name ?? "Lorebook",
      patch: { wholeWords: entries.map((entry) => ({ id: entry.id, name: entry.name })) },
      reason:
        'Whole words is off, so a key also matches inside longer words ("Ame" in "game"). On, a key matches only as a ' +
        "word of its own; a plural then needs its own key.",
      source: "crawler",
    });
    count += entries.length;
  }
  return count;
}

// ── The run ──

export interface CrawlerOutcome {
  status: LmCrawlerRunStatus;
  run: LmCrawlerRunRecord | null;
  /** Why nothing ran, when no run was recorded. */
  detail?: string;
}

export interface CrawlerRunOptions {
  /** Only these entries (an applied Archivist change); otherwise the next batch of untidied ones. */
  entryIds?: readonly string[];
  trigger?: LmCrawlerRunRecord["trigger"];
  /** The chat whose connection backs up the Crawler's own (after an Archivist change). */
  chatId?: string | null;
  signal?: AbortSignal;
}

export async function runCrawler(compendiumId: string, options: CrawlerRunOptions = {}): Promise<CrawlerOutcome> {
  const startedAt = Date.now();
  const runtime = getLorebookManagerRuntime();
  const documents = runtime.persistence.documents;
  const trigger = options.trigger ?? "manual";
  const compendium = await getCompendium(documents, compendiumId);
  const base = (status: LmCrawlerRunStatus, detail?: string): LmCrawlerRunRecord => ({
    at: new Date().toISOString(),
    compendiumId,
    compendiumName: compendium?.name ?? null,
    status,
    trigger,
    entryCount: 0,
    proposals: 0,
    remaining: 0,
    skipped: [],
    proposalIds: [],
    model: null,
    ms: Date.now() - startedAt,
    ...(detail ? { detail } : {}),
  });
  if (!compendium) return { status: "not_found", run: null };
  const finish = async (run: LmCrawlerRunRecord): Promise<CrawlerOutcome> => {
    await recordRun(documents, run);
    return { status: run.status, run };
  };
  if (compendium.lorebookIds.length === 0) return finish(base("nothing_to_do", "This Compendium has no lorebooks"));

  const settings = await getSettings(documents);
  const crawler = settings.crawler;
  const [payload, { state }, pending] = await Promise.all([
    compendiumGraph(compendium, true),
    readState(documents, compendiumId),
    listProposals(documents, "pending"),
  ]);
  const everyUntidied = untidied(payload, compendium, state, pending);
  let candidates = everyUntidied;
  if (options.entryIds) {
    const wanted = new Set(options.entryIds);
    candidates = candidates.filter((entry) => wanted.has(entry.id));
  }
  const batch = candidates.slice(0, crawler.batchSize);
  let remainingAfter = trigger === "after_archivist" ? 0 : Math.max(0, everyUntidied.length - batch.length);
  const wholeWords = trigger === "manual" ? await suggestWholeWords(documents, payload, compendium) : 0;
  const wholeWordsNote =
    wholeWords > 0
      ? `Whole words: a suggestion for ${wholeWords} ${wholeWords === 1 ? "entry" : "entries"} waits in Review`
      : undefined;
  if (batch.length === 0) {
    // After an Archivist change there's nothing to say when the entry is already tidy: record only Tidy entries.
    if (trigger === "after_archivist") return { status: "nothing_to_do", run: null };
    const books = new Set(compendium.lorebookIds);
    const waiting = pending.filter(
      (proposal) => proposal.source === "crawler" && books.has(proposal.lorebookId),
    ).length;
    const nothing =
      waiting > 0 ? `Nothing left to tidy; ${waiting} Crawler suggestions wait in Review` : "Every entry is tidied";
    return finish(base("nothing_to_do", wholeWordsNote ? `${nothing}. ${wholeWordsNote}` : nothing));
  }
  const languageModels = runtime.languageModels;
  if (!languageModels) return finish(base("unavailable", "This Engine has no language model host"));

  // Link targets: what each entry's text mentions (the Graph's mention lines), that it doesn't link to yet.
  const nodesByRef = new Map(payload.nodes.map((node) => [node.ref, node] as const));
  const nameOf = (raw: string) => {
    const node = nodesByRef.get(parseEntityRef(raw)?.ref ?? raw);
    return node && node.nodeType !== "lorebook" ? node.name : raw;
  };
  const shortIds = new Map<string, string>();
  const byShortId = new Map<string, LmEntryNode | LmEntityNode>();
  const linkTargets = new Map<string, Array<{ shortId: string; node: LmEntryNode | LmEntityNode }>>();
  for (const entry of batch) {
    const linked = new Set(Object.keys(entry.relationships).map((key) => parseEntityRef(key)?.ref ?? key));
    const targets: Array<{ shortId: string; node: LmEntryNode | LmEntityNode }> = [];
    for (const edge of payload.mentionEdges) {
      if (edge.sourceRef !== entry.ref || linked.has(edge.targetRef) || targets.length >= MAX_LINK_TARGETS) continue;
      const node = nodesByRef.get(edge.targetRef);
      if (!node || node.nodeType === "lorebook") continue;
      let shortId = shortIds.get(node.ref);
      if (!shortId) {
        if (shortIds.size >= MAX_TARGETS) continue;
        shortId = `t${shortIds.size + 1}`;
        shortIds.set(node.ref, shortId);
        byShortId.set(shortId, node);
      }
      targets.push({ shortId, node });
    }
    linkTargets.set(entry.ref, targets);
  }
  // A key several entries share is a broad one; the prompt says so next to it.
  const ownBooks = new Set(compendium.lorebookIds);
  const keyUse = new Map<string, number>();
  for (const node of payload.nodes) {
    if (node.nodeType !== "lore" || !ownBooks.has(node.lorebookId)) continue;
    for (const key of new Set(node.keys.map(comparableFact))) if (key) keyUse.set(key, (keyUse.get(key) ?? 0) + 1);
  }
  // Ladders (is_a, member_of, located_in): a target the entry already reaches through a lower rung is dropped.
  const linksOf = (ref: string) => {
    const node = nodesByRef.get(ref);
    if (!node || node.nodeType !== "lore") return [];
    return Object.entries(node.relationships).map(([key, relation]) => ({
      ref: parseEntityRef(key)?.ref ?? key,
      relation: String(relation).trim().toLowerCase(),
    }));
  };
  const reaches = (fromRef: string, relation: string, targetRef: string): boolean => {
    const seen = new Set([fromRef]);
    const queue = [fromRef];
    while (queue.length > 0) {
      for (const link of linksOf(queue.shift()!)) {
        if (link.relation !== relation || seen.has(link.ref)) continue;
        if (link.ref === targetRef) return true;
        seen.add(link.ref);
        queue.push(link.ref);
      }
    }
    return false;
  };

  let modelName: string | null = null;
  let answer: unknown;
  const failed = (detail: string) =>
    finish({ ...base("failed", detail), entryCount: batch.length, model: modelName, remaining: candidates.length });
  try {
    let chatConnectionId: string | null = null;
    if (options.chatId && typeof runtime.persistence.getChat === "function") {
      chatConnectionId = (await runtime.persistence.getChat(options.chatId))?.connectionId ?? null;
    }
    const model = await languageModels.resolveForRequest({
      connectionId: crawler.connectionId ?? settings.archivist.connectionId,
      chatConnectionId,
    });
    modelName = model.model;
    const completion = await model.chatComplete(
      [
        { role: "system", content: CRAWLER_SYSTEM },
        { role: "user", content: crawlerUserPrompt(batch, linkTargets, nameOf, keyUse) },
      ],
      {
        ...(crawler.temperature === null ? {} : { temperature: crawler.temperature }),
        maxTokens: crawler.maxTokens,
        signal: backgroundModelSignal(options.signal),
      },
    );
    if (options.signal?.aborted) return { status: "failed", run: null };
    if (completion.finishReason === "length") {
      return failed("The model's answer was cut off: raise Max tokens or lower Entries per run in Settings → Crawler");
    }
    answer = completion.content ? safeParse(completion.content) : null;
  } catch (error) {
    if (options.signal?.aborted) return { status: "failed", run: null };
    return failed(error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
  const parsed = asRecord(answer);
  if (!Array.isArray(parsed.entries)) return failed("The model's answer wasn't readable");

  const skipped: LmCrawlerRunRecord["skipped"] = [];
  const proposalIds: string[] = [];
  const byEntryId = new Map<string, LmEntryNode>(batch.map((entry, index) => [`e${index + 1}`, entry]));
  const answered = new Set<string>();
  const tidied: LmEntryNode[] = [];
  const tried: LmEntryNode[] = [];
  for (const raw of parsed.entries) {
    const item = asRecord(raw);
    const shortId = cleanText(item.id, 12);
    const entry = byEntryId.get(shortId);
    if (!entry || answered.has(entry.id)) {
      if (!entry) skipped.push({ name: shortId || "?", why: "unknown entry" });
      continue;
    }
    answered.add(entry.id);
    const patch: Record<string, unknown> = {};
    const description = cleanText(item.description, DESCRIPTION_CHARS);
    if (description && !entry.description.trim()) patch.description = description;
    const tag = cleanText(item.tag, TAG_CHARS).toLowerCase();
    if (tag && !entry.tag.trim()) patch.tag = tag;
    // A too-broad key out: only one the entry has, never its own name, and at least one key stays (checked below).
    const ownName = comparableFact(entry.name);
    const removeKeys: string[] = [];
    for (const key of Array.isArray(item.removeKeys) ? item.removeKeys : []) {
      const wanted = comparableFact(cleanText(key, 60));
      const existing = entry.keys.find((candidate) => comparableFact(candidate) === wanted);
      if (!wanted || !existing || wanted === ownName || removeKeys.includes(existing)) continue;
      removeKeys.push(existing);
    }
    if (item.constant === false && entry.constant) patch.constant = false;
    // The entry's name may join its keys: a swap ("Shadow" out, "Shadow Clone Technique" in) needs it.
    const known = new Set(entry.keys.map(comparableFact));
    const addKeys: string[] = [];
    // `keys` was phase 1's name for the field; an older prompt's answer still reads.
    const keysAnswer = Array.isArray(item.addKeys) ? item.addKeys : Array.isArray(item.keys) ? item.keys : [];
    for (const key of keysAnswer) {
      const clean = cleanText(key, 60);
      const comparable = comparableFact(clean);
      if (!comparable || known.has(comparable)) continue;
      // A removed key frees its place: a broad key can be swapped for its real alias on a full entry.
      const total = entry.keys.length - removeKeys.length + addKeys.length;
      if (addKeys.length >= MAX_KEYS_ADDED || total >= MAX_KEYS_TOTAL) break;
      known.add(comparable);
      addKeys.push(clean);
    }
    if (addKeys.length > 0) patch.addKeys = addKeys;
    // Without a better key in addKeys, the last one stays.
    while (removeKeys.length > 0 && entry.keys.length - removeKeys.length + addKeys.length < 1) removeKeys.pop();
    if (removeKeys.length > 0) patch.removeKeys = removeKeys;
    const allowed = new Map((linkTargets.get(entry.ref) ?? []).map((target) => [target.shortId, target.node]));
    const addLinks: Array<CrawlerLink & { ref: string }> = [];
    for (const rawLink of Array.isArray(item.links) ? item.links : []) {
      const link = asRecord(rawLink);
      const to = cleanText(link.to, 12);
      const relation = cleanText(link.relation, 30).toLowerCase();
      const node = allowed.get(to);
      if (!node || !byShortId.has(to)) {
        if (to) skipped.push({ name: `${entry.name} → ${to}`, why: "not a mentioned target" });
        continue;
      }
      if (!CRAWLER_RELATIONS.includes(relation)) {
        skipped.push({ name: `${entry.name} → ${node.name}`, why: `unknown relation "${relation}"` });
        continue;
      }
      const key = toRelationshipKey(node.ref);
      if (addLinks.some((existing) => existing.key === key) || addLinks.length >= MAX_LINKS_ADDED) continue;
      addLinks.push({ key, relation, name: displayName(node), ref: node.ref });
    }
    const links = addLinks.filter((link) => {
      if (!LADDER_RELATIONS.has(link.relation)) return true;
      const rungs = [
        ...linksOf(entry.ref)
          .filter((other) => other.relation === link.relation)
          .map((other) => other.ref),
        ...addLinks.filter((other) => other.relation === link.relation).map((other) => other.ref),
      ];
      const lower = rungs.find((ref) => ref !== link.ref && reaches(ref, link.relation, link.ref));
      if (lower) skipped.push({ name: `${entry.name} → ${link.name}`, why: `already under ${nameOf(lower)}` });
      return !lower;
    });
    if (links.length > 0) patch.addLinks = links.map(({ key, relation, name }) => ({ key, relation, name }));
    // A summary is required where the entry has none: without one the entry isn't tidied, up to MAX_SUMMARY_TRIES.
    if (!entry.description.trim() && !patch.description) {
      const tries = (state.attempts[entry.id] ?? 0) + 1;
      if (tries >= MAX_SUMMARY_TRIES) {
        tidied.push(entry);
        skipped.push({ name: entry.name, why: `no summary after ${tries} tries` });
      } else {
        tried.push(entry);
        skipped.push({ name: entry.name, why: "no summary; asked again next run" });
      }
    } else {
      tidied.push(entry);
    }
    if (Object.keys(patch).length === 0) continue;
    const proposal = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: entry.lorebookId,
      targetEntryId: entry.id,
      entryName: entry.name,
      patch,
      reason: "Tidy entries: what the entry was missing",
      source: "crawler",
      chatId: options.chatId ?? null,
    });
    proposalIds.push(proposal.id);
  }

  // An entry the model answered for counts as tidied, also with nothing to add (but its summary, if it had none); one
  // it left out stays untidied and counts a try, so it moves behind the entries not tried yet.
  const leftOut = batch.filter((entry) => !answered.has(entry.id));
  tried.push(...leftOut);
  await saveCrawlState(documents, compendiumId, { tidied, tried });
  if (leftOut.length > 0) {
    skipped.push({ name: `${leftOut.length} entries`, why: "not answered, left for the next run" });
  }
  remainingAfter += batch.length - tidied.length;
  const run: LmCrawlerRunRecord = {
    ...base("done", wholeWordsNote),
    entryCount: batch.length,
    entryIds: batch.map((entry) => entry.id),
    proposals: proposalIds.length,
    remaining: remainingAfter,
    skipped,
    proposalIds,
    model: modelName,
    ms: Date.now() - startedAt,
  };
  runtime.logger.debug(
    "[lorebook-manager] Crawler %s: %d entries, %d suggestions, %d skipped, %d left, %d ms",
    compendium.name,
    batch.length,
    proposalIds.length,
    skipped.length,
    remainingAfter,
    run.ms,
  );
  return finish(run);
}

/**
 * Redo last batch, for a model hiccup: the newest finished batch's waiting suggestions are dismissed and its entries
 * asked again. An entry whose suggestion from that batch was applied stays as it is.
 */
export async function redoLastCrawl(
  compendiumId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CrawlerOutcome> {
  const documents = getLorebookManagerRuntime().persistence.documents;
  if (!(await getCompendium(documents, compendiumId))) return { status: "not_found", run: null };
  const last = (await listCrawlerRuns()).find(
    (run) => run.compendiumId === compendiumId && run.status === "done" && (run.entryIds?.length ?? 0) > 0,
  );
  if (!last) return { status: "nothing_to_do", run: null, detail: "No batch to redo yet" };
  const fromRun = new Set(last.proposalIds);
  const applied = new Set<string>();
  for (const proposal of await listProposals(documents)) {
    if (!fromRun.has(proposal.id) || proposal.kind !== "update_entry" || !proposal.targetEntryId) continue;
    if (proposal.status === "applied") applied.add(proposal.targetEntryId);
    else if (proposal.status === "pending") await dismissProposal(documents, proposal.id);
  }
  const again = last.entryIds!.filter((id) => !applied.has(id));
  if (again.length === 0) {
    return { status: "nothing_to_do", run: null, detail: "Every suggestion from the last batch was applied" };
  }
  await saveCrawlState(documents, compendiumId, { untidy: again });
  return runCrawler(compendiumId, { entryIds: again, trigger: "redo", signal: options.signal });
}

/** The Compendium an applied Archivist change belongs to: its chat's, else the first one holding its lorebook. */
async function compendiumOf(proposal: LmProposal): Promise<LmCompendium | null> {
  const fromChat = proposal.chatId ? compendiumForChat(proposal.chatId) : null;
  if (fromChat && fromChat.lorebookIds.includes(proposal.lorebookId)) return fromChat;
  const all = await listCompendiums(getLorebookManagerRuntime().persistence.documents);
  return all.find((compendium) => compendium.lorebookIds.includes(proposal.lorebookId)) ?? null;
}

/** Applied Archivist changes waiting to be tidied together, per Compendium. */
interface WaitingCrawl {
  entryIds: Set<string>;
  /** null once the gathered entries come from more than one chat. */
  chatId: string | null;
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<CrawlerOutcome | null>;
  resolve: (outcome: CrawlerOutcome | null) => void;
}
const waitingCrawls = new Map<string, WaitingCrawl>();

/** Add an entry to the Compendium's waiting crawl and start the wait again; all of them share one run. */
function scheduleCrawl(compendiumId: string, entryId: string, chatId: string | null, waitMs: number) {
  let waiting = waitingCrawls.get(compendiumId);
  if (!waiting) {
    let resolve: (outcome: CrawlerOutcome | null) => void = () => undefined;
    const done = new Promise<CrawlerOutcome | null>((settle) => (resolve = settle));
    waiting = { entryIds: new Set(), chatId, firstAt: Date.now(), timer: null, done, resolve };
    waitingCrawls.set(compendiumId, waiting);
  } else if (waiting.chatId !== chatId) {
    // Suggestions from several chats: none of them owns the run (its connection falls back to the Crawler's own).
    waiting.chatId = null;
  }
  const current = waiting;
  current.entryIds.add(entryId);
  if (current.timer) clearTimeout(current.timer);
  const deadline = current.firstAt + waitMs * AFTER_ARCHIVIST_MAX_WAITS;
  current.timer = setTimeout(
    () => {
      waitingCrawls.delete(compendiumId);
      const entryIds = [...current.entryIds];
      runInBackgroundQueue(async () => {
        // More applied entries than one run takes: one run per batch, so each gets its tidy pass.
        const { batchSize } = (await getSettings(getLorebookManagerRuntime().persistence.documents)).crawler;
        let outcome: CrawlerOutcome | null = null;
        for (let start = 0; start < entryIds.length; start += batchSize) {
          const chunk = entryIds.slice(start, start + batchSize);
          outcome = await runCrawler(compendiumId, {
            entryIds: chunk,
            trigger: "after_archivist",
            chatId: current.chatId,
          });
          if (outcome.status === "failed" || outcome.status === "unavailable") break;
        }
        return outcome;
      }).then(current.resolve, (error: unknown) => {
        getLorebookManagerRuntime().logger.warn("[lorebook-manager] Crawler after Archivist changes failed: %s", error);
        current.resolve(null);
      });
    },
    Math.max(0, Math.min(waitMs, deadline - Date.now())),
  );
  return current.done;
}

/**
 * After an Archivist change is applied: tidy that entry in the background, when the Crawler runs after the
 * Archivist. Applies within `waitMs` of each other share one run (clicking through Review's stack is one call, not
 * one per Apply; Ylli's round 5). Never throws; the apply request doesn't wait for it.
 */
export async function crawlAfterArchivist(
  proposal: LmProposal,
  { waitMs = AFTER_ARCHIVIST_WAIT_MS }: { waitMs?: number } = {},
): Promise<CrawlerOutcome | null> {
  try {
    if (proposal.source !== "archivist" || proposal.status !== "applied" || !proposal.appliedEntryId) return null;
    const runtime = getLorebookManagerRuntime();
    const settings = await getSettings(runtime.persistence.documents);
    if (settings.crawler.trigger !== "after_archivist") return null;
    const compendium = await compendiumOf(proposal);
    if (!compendium) return null;
    return await scheduleCrawl(compendium.id, proposal.appliedEntryId, proposal.chatId, waitMs);
  } catch (error) {
    getLorebookManagerRuntime().logger.warn("[lorebook-manager] Crawler after an Archivist change failed: %s", error);
    return null;
  }
}
