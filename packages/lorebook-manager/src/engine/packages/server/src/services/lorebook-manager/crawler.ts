import {
  parseEntityRef,
  toRelationshipKey,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import { LM_RELATION_VALUES } from "../../../../shared/src/features/agents/lorebook-manager/relations.js";
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
// Phase 1 suggests a summary and a tag where an entry has none, a few more keywords, and links to the entries and
// cards its text mentions. Facets (dynamicState) come later. Everything goes to Review, one suggestion per entry.
// An entry counts as tidied once the model has seen it with its current name and content; editing either (an
// applied Archivist fact, a hand edit) queues it again.

const CONTENT_CHARS = 1_500;
const MAX_LINK_TARGETS = 12;
const MAX_TARGETS = 200;
const MAX_KEYS_ADDED = 4;
const MAX_KEYS_TOTAL = 12;
const MAX_LINKS_ADDED = 6;
const DESCRIPTION_CHARS = 240;
const TAG_CHARS = 40;
const MAX_RECORDED_RUNS = 20;

export const CRAWLER_RUN_DOC_KIND = "crawler_run";
export const CRAWLER_STATE_DOC_KIND = "crawler_state";

/** Relations the Crawler may write. `represents` hides an entry while its card is active: a person's call. */
const CRAWLER_RELATIONS = LM_RELATION_VALUES.filter((value) => value !== "represents");

const stateDocId = (compendiumId: string) => `crawler_state:${compendiumId}`;
const runDocId = (compendiumId: string) => `crawler_run:${compendiumId}`;

/** What the model read of an entry: its name and content. A change to either makes the entry untidied again. */
export function crawlHash(entry: Pick<LmEntryNode, "name" | "content">): string {
  const text = `${entry.name}\n${entry.content}`;
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
  "You tidy a roleplay's lorebook entries. For each entry in <entries>, fill in only what helps find and connect it.",
  "description: one plain sentence saying what the entry is (who, what or where), only if the entry has none.",
  "tag: one or two lowercase words for its kind (character, location, item, faction, species, ability, event,",
  "concept, ...), only if the entry has none.",
  "keys: up to 4 more names, aliases or short phrases the story would use for it, that the entry doesn't list yet.",
  "links: for the targets listed under the entry, the ones its text really connects it to, each with one relation:",
  `${CRAWLER_RELATIONS.join(", ")}. A link reads "<entry> <relation> <target>": "Student member_of Class 1-A".`,
  "Skip a target the text only names in passing. Never invent; leave a field out when unsure.",
  'Answer for every entry; an entry with nothing to add is just {"id": "e2"}.',
  'Answer with JSON only: {"entries": [{"id": "e1", "description": "...", "tag": "...", "keys": ["..."],',
  '"links": [{"to": "t3", "relation": "member_of"}]}]}',
].join(" ");

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
    const waiting = pending.filter((proposal) => proposal.source === "crawler").length;
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
        temperature: 0.2,
        maxTokens: Math.min(4_000, 300 + batch.length * 160),
        signal: backgroundModelSignal(options.signal),
      },
    );
    if (options.signal?.aborted) return { status: "failed", run: null };
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
    const known = new Set([...entry.keys, entry.name].map(comparableFact));
    const addKeys: string[] = [];
    for (const key of Array.isArray(item.keys) ? item.keys : []) {
      const clean = cleanText(key, 60);
      const comparable = comparableFact(clean);
      if (!comparable || known.has(comparable)) continue;
      if (addKeys.length >= MAX_KEYS_ADDED || entry.keys.length + addKeys.length >= MAX_KEYS_TOTAL) break;
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

/**
 * After an Archivist change is applied: tidy that entry in the background, when the Crawler runs after the
 * Archivist. Never throws; the apply request doesn't wait for it.
 */
export async function crawlAfterArchivist(proposal: LmProposal): Promise<CrawlerOutcome | null> {
  try {
    if (proposal.source !== "archivist" || proposal.status !== "applied" || !proposal.appliedEntryId) return null;
    const runtime = getLorebookManagerRuntime();
    const settings = await getSettings(runtime.persistence.documents);
    if (settings.crawler.trigger !== "after_archivist") return null;
    const compendium = await compendiumOf(proposal);
    if (!compendium) return null;
    const entryId = proposal.appliedEntryId;
    return await runInBackgroundQueue(() =>
      runCrawler(compendium.id, { entryIds: [entryId], trigger: "after_archivist", chatId: proposal.chatId }),
    );
  } catch (error) {
    getLorebookManagerRuntime().logger.warn("[lorebook-manager] Crawler after an Archivist change failed: %s", error);
    return null;
  }
}
