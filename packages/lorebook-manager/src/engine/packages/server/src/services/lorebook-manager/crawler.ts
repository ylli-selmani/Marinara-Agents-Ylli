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
import { comparableFact, createProposal, listProposals } from "./proposals-store.js";
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
 * while its card is active: a person's call too.
 */
const CRAWLER_RELATION_DEFS = LM_RELATIONS.filter(
  (relation) => relation.value !== "related_to" && relation.value !== "represents",
);
const CRAWLER_RELATIONS = CRAWLER_RELATION_DEFS.map((relation) => relation.value);
const AFTER_ARCHIVIST_WAIT_MS = 20_000;
/** A steady stream of Applies can't hold the run back longer than this after the first one. */
const AFTER_ARCHIVIST_MAX_WAITS = 3;

const stateDocId = (compendiumId: string) => `crawler_state:${compendiumId}`;
const runDocId = (compendiumId: string) => `crawler_run:${compendiumId}`;

/**
 * Bumped when the Crawler's rules change enough to look again: every entry is untidied once (2: round 5's prompt, with
 * key removal, "always on" and no related_to). Costs nothing until Tidy entries runs.
 */
const CRAWLER_RULES_VERSION = 2;

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
}

async function readState(
  documents: LorebookManagerDocumentStore,
  compendiumId: string,
): Promise<{ state: CrawlerState; revision: number | null }> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, stateDocId(compendiumId));
  const raw = (doc?.data as { crawled?: unknown } | undefined)?.crawled;
  const crawled: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, hash] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof hash === "string") crawled[id] = hash;
    }
  }
  return { state: { crawled }, revision: doc ? doc.revision : null };
}

async function markCrawled(
  documents: LorebookManagerDocumentStore,
  compendiumId: string,
  entries: readonly LmEntryNode[],
): Promise<void> {
  const { state, revision } = await readState(documents, compendiumId);
  const crawled = { ...state.crawled };
  for (const entry of entries) crawled[entry.id] = crawlHash(entry);
  const now = new Date().toISOString();
  const data = { compendiumId, crawled };
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

/** Entries the Crawler may still tidy: unlocked, changed since it last looked, no Crawler suggestion waiting. */
function untidied(
  payload: LmGraphPayload,
  compendium: LmCompendium,
  crawled: Record<string, string>,
  pending: readonly LmProposal[],
): LmEntryNode[] {
  const books = new Set(compendium.lorebookIds);
  const waiting = new Set(
    pending.filter((proposal) => proposal.source === "crawler").map((proposal) => proposal.targetEntryId),
  );
  return payload.nodes
    .filter((node): node is LmEntryNode => node.nodeType === "lore" && books.has(node.lorebookId))
    .filter((entry) => !entry.locked && !waiting.has(entry.id) && crawled[entry.id] !== crawlHash(entry))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => gapScore(b.entry) - gapScore(a.entry) || a.index - b.index)
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
  return untidied(payload, compendium, state.crawled, pending).length;
}

// ── The prompt ──

export const CRAWLER_SYSTEM = [
  "You tidy a roleplay's lorebook so the right entries come up during play. For each entry in <entries>, suggest",
  "only what is clearly missing or wrong. Most entries need little; an empty answer is a good answer.",
  "",
  "description: one plain sentence saying what the entry is (who, what or where). Only if the entry has none.",
  "tag: one or two lowercase words for its kind (character, location, item, faction, species, ability, event,",
  "concept, ...). Only if the entry has none.",
  "",
  "Keywords bring an entry into the story whenever one appears in the chat, without any further check. So:",
  "addKeys: at most 2 names or aliases the story really calls it by and the entry lacks. Never descriptions",
  '("red-haired shinobi"), titles of other things, or generic phrases.',
  "removeKeys: keys the entry already has that are too broad on their own: a common word that would bring it in for",
  'unrelated text ("Ten" for Ten-Tails, "Team" for Team Guy, "Dark", "water"). Copy them exactly. Never the',
  "entry's own name, and leave it at least one key.",
  'constant: false, only for an entry marked "always on: yes" that isn\'t lore every scene needs (a person, place or',
  "event that matters only when it comes up).",
  "",
  "links: a link is a lasting fact about how the entry relates to a target; when the entry comes up, the link brings",
  'the target along. It reads "<entry> <relation> <target>". Only these relations:',
  ...CRAWLER_RELATION_DEFS.map((relation) => `- ${relation.value}: ${relation.hint}`),
  "Link only when the relation is plainly true from the entry's text. Naming, mentioning or comparing a target is",
  "not a link: an encounter prompt that names three teams links to none of them. At most 3 links per entry, only to",
  "targets listed under that entry. When no relation above fits exactly, leave the link out.",
  "",
  "Never invent; leave a field out when unsure. Answer for every entry; one with nothing to add is just",
  '{"id": "e2"}. Answer with JSON only:',
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
): string {
  const blocks = batch.map((entry, index) => {
    const content = entry.content.length > CONTENT_CHARS ? `${entry.content.slice(0, CONTENT_CHARS)}…` : entry.content;
    const links = Object.entries(entry.relationships)
      .map(([target, relation]) => `${relation} ${nameOf(target)}`)
      .join(", ");
    const targets = (linkTargets.get(entry.ref) ?? []).map((item) => `${item.shortId} ${displayName(item.node)}`);
    return [
      `[e${index + 1}] ${entry.name}`,
      `description: ${entry.description.trim() || "(none)"}`,
      `tag: ${entry.tag.trim() || "(none)"}`,
      `keys: ${entry.keys.join(", ") || "(none)"}`,
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

// ── The run ──

export interface CrawlerOutcome {
  status: LmCrawlerRunStatus;
  run: LmCrawlerRunRecord | null;
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
  let candidates = untidied(payload, compendium, state.crawled, pending);
  if (options.entryIds) {
    const wanted = new Set(options.entryIds);
    candidates = candidates.filter((entry) => wanted.has(entry.id));
  }
  const batch = candidates.slice(0, crawler.batchSize);
  let remainingAfter = options.entryIds ? 0 : Math.max(0, candidates.length - batch.length);
  if (batch.length === 0) {
    // After an Archivist change there's nothing to say when the entry is already tidy: record only Tidy entries.
    if (trigger !== "manual") return { status: "nothing_to_do", run: null };
    const books = new Set(compendium.lorebookIds);
    const waiting = pending.filter(
      (proposal) => proposal.source === "crawler" && books.has(proposal.lorebookId),
    ).length;
    return finish(
      base(
        "nothing_to_do",
        waiting > 0 ? `Nothing left to tidy; ${waiting} Crawler suggestions wait in Review` : "Every entry is tidied",
      ),
    );
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
        { role: "user", content: crawlerUserPrompt(batch, linkTargets, nameOf) },
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
    // A too-broad key out: only one the entry has, never its own name, and at least one key stays.
    const ownName = comparableFact(entry.name);
    const removeKeys: string[] = [];
    for (const key of Array.isArray(item.removeKeys) ? item.removeKeys : []) {
      const wanted = comparableFact(cleanText(key, 60));
      const existing = entry.keys.find((candidate) => comparableFact(candidate) === wanted);
      if (!wanted || !existing || wanted === ownName || removeKeys.includes(existing)) continue;
      if (entry.keys.length - removeKeys.length <= 1) break;
      removeKeys.push(existing);
    }
    if (removeKeys.length > 0) patch.removeKeys = removeKeys;
    if (item.constant === false && entry.constant) patch.constant = false;
    const known = new Set([...entry.keys, entry.name].map(comparableFact));
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
    const allowed = new Map((linkTargets.get(entry.ref) ?? []).map((target) => [target.shortId, target.node]));
    const addLinks: CrawlerLink[] = [];
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
      addLinks.push({ key, relation, name: displayName(node) });
    }
    if (addLinks.length > 0) patch.addLinks = addLinks;
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

  // An entry the model answered for counts as tidied, also with nothing to add; one it left out stays untidied.
  const tidied = batch.filter((entry) => answered.has(entry.id));
  await markCrawled(documents, compendiumId, tidied);
  if (tidied.length < batch.length) {
    skipped.push({ name: `${batch.length - tidied.length} entries`, why: "not answered, left for the next run" });
  }
  remainingAfter += batch.length - tidied.length;
  const run: LmCrawlerRunRecord = {
    ...base("done"),
    entryCount: batch.length,
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
