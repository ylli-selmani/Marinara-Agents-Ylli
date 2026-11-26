import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import { resolveArchivistSettings } from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import type {
  LmArchivistRunRecord,
  LmArchivistRunStatus,
  LmCompendium,
  LmEntryNode,
  LmGraphPayload,
  LmProposal,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { agentAddedToChat, compendiumForChat } from "./live-claims.js";
import { parseExtra } from "./live-retrieval.js";
import {
  getLorebookManagerRuntime,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
} from "./package-runtime.js";
import { appendProposalFacts, comparableFact, createProposal, listProposals, novelFacts } from "./proposals-store.js";
import { buildLorebookManagerGraphPayload } from "./routes.js";
import { getSettings } from "./settings-store.js";

// ── The Archivist: Lookup-then-Diff after the turn, in the background (Long-Term Memory's auto-import pattern). ──
// The contributor arms a job per chat; after a quiet period the job reads the settled messages past its watermark,
// looks up the entries they touch (Stage 1 over the window), and asks one model for new facts and new entries.
// Everything goes to Review until B1c (Automatic mode with Undo).

/** A job waits this long after the last turn in its chat... */
export const ARCHIVIST_QUIET_MS = 4_000;
/** ...but never longer than this after the first waiting turn, so a busy chat still gets archived. */
const ARCHIVIST_MAX_WAIT_MS = 20_000;
/** The contributor runs before the reply exists: while the newest message is still the user's, look again later. */
const REPLY_WAIT_MS = 5_000;
const REPLY_WAIT_MAX = 36;
/** A failed run (model error, unreadable answer) isn't retried on every turn. */
export const ARCHIVIST_FAILURE_COOLDOWN_MS = 10 * 60_000;

const MAX_WINDOW_MESSAGES = 24;
const MAX_WINDOW_CHARS = 16_000;
const CANDIDATE_LIMIT = 25;
const CANDIDATE_CONTENT_CHARS = 1_500;
const DIRECTORY_LIMIT = 400;
const MAX_UPDATES = 8;
const MAX_FACTS = 6;
const MAX_FACT_CHARS = 400;
const MAX_CREATES = 5;
const MAX_CREATE_CHARS = 2_000;
const MAX_RECORDED_RUNS = 20;
/**
 * A backstop so nothing holds the package's background queue forever. The host already ends a stream that goes
 * quiet; this only caps a call that keeps streaming, long enough for a 4k-token Crawler answer on a slow model.
 */
export const BACKGROUND_MODEL_TIMEOUT_MS = 5 * 60_000;

/** The caller's signal (deactivation), plus the deadline. */
export function backgroundModelSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(BACKGROUND_MODEL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export const ARCHIVIST_RUN_DOC_KIND = "archivist_run";
export const ARCHIVIST_STATE_DOC_KIND = "archivist_state";

const CATEGORIES = [
  "character",
  "location",
  "item",
  "faction",
  "species",
  "creature",
  "ability",
  "quest",
  "event",
  "concept",
] as const;
type Category = (typeof CATEGORIES)[number];

// ── One background model call at a time for the whole package (the Crawler will queue here too). ──
// The in-turn gate stays outside: it has its own short deadline and must never wait behind a long Archivist call.
let backgroundQueue: Promise<unknown> = Promise.resolve();

export function runInBackgroundQueue<T>(task: () => Promise<T>): Promise<T> {
  const next = backgroundQueue.then(task, task);
  backgroundQueue = next.catch(() => undefined);
  return next;
}

// ── Jobs ──

interface Job {
  chatId: string;
  /** A turn arrived during a run: arm again when it ends. */
  again: boolean;
  replyWaits: number;
  firstRequestAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  controller?: AbortController;
}

const jobs = new Map<string, Job>();
let stopped = false;

function schedule(job: Job, quietMs: number, restartWait = false): void {
  const now = Date.now();
  if (restartWait) job.firstRequestAt = now;
  job.firstRequestAt ??= now;
  clearTimeout(job.timer);
  const delay = Math.max(0, Math.min(quietMs, job.firstRequestAt + ARCHIVIST_MAX_WAIT_MS - now));
  job.timer = setTimeout(() => fire(job), delay);
  // A waiting job must not keep the process alive: the next turn after a restart arms it again.
  (job.timer as { unref?: () => void }).unref?.();
}

function fire(job: Job): void {
  clearTimeout(job.timer);
  job.timer = undefined;
  job.firstRequestAt = undefined;
  const controller = new AbortController();
  job.controller = controller;
  let waitForReply = false;
  job.running = runInBackgroundQueue(() => runArchivist(job.chatId, { signal: controller.signal }))
    .then((outcome) => {
      waitForReply = outcome.status === "reply_pending";
      if (outcome.more) job.again = true;
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted)
        getLorebookManagerRuntime().logger.warn(
          "[lorebook-manager] Archivist failed for chat %s: %s",
          job.chatId,
          error,
        );
    })
    .finally(() => {
      job.running = undefined;
      job.controller = undefined;
      if (stopped || jobs.get(job.chatId) !== job) return;
      if (waitForReply && job.replyWaits < REPLY_WAIT_MAX) {
        job.replyWaits += 1;
        schedule(job, REPLY_WAIT_MS, true);
        return;
      }
      job.replyWaits = 0;
      if (!job.again) {
        jobs.delete(job.chatId);
        return;
      }
      job.again = false;
      schedule(job, ARCHIVIST_QUIET_MS);
    });
}

/** A turn in this chat (from the contributor): start or extend its quiet period, or run once more after this run. */
export function armArchivist(chatId: string): void {
  if (stopped) return;
  const job = jobs.get(chatId) ?? { chatId, again: false, replyWaits: 0 };
  jobs.set(chatId, job);
  if (job.running) job.again = true;
  else schedule(job, ARCHIVIST_QUIET_MS);
}

/** Test hook: a run is waiting or running for this chat. */
export function isArchivistArmed(chatId: string): boolean {
  return jobs.has(chatId);
}

/** Package deactivation: drop waiting jobs, abort running ones, and arm nothing more. */
export async function stopArchivist(): Promise<void> {
  stopped = true;
  const running: Array<Promise<void> | undefined> = [];
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.controller?.abort();
    running.push(job.running);
  }
  jobs.clear();
  await Promise.all(running);
}

/** Package activation: jobs may be armed again. */
export function resumeArchivist(): void {
  stopped = false;
}

// ── The watermark: the last settled message this chat's Archivist has read. ──

interface ArchivistState {
  lastMessageId: string | null;
  lastMessageAt: string | null;
  failedAt: string | null;
}

const stateDocId = (chatId: string) => `archivist_state:${chatId}`;
const runDocId = (chatId: string) => `archivist_run:${chatId}`;

async function readState(
  documents: LorebookManagerDocumentStore,
  chatId: string,
): Promise<{ state: ArchivistState; revision: number | null; name: string }> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, stateDocId(chatId));
  const data = (doc?.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    state: {
      lastMessageId: text(data.lastMessageId),
      lastMessageAt: text(data.lastMessageAt),
      failedAt: text(data.failedAt),
    },
    revision: doc ? doc.revision : null,
    name: doc?.name ?? `Archivist state for chat ${chatId}`,
  };
}

async function writeState(
  documents: LorebookManagerDocumentStore,
  chatId: string,
  current: { revision: number | null; name: string },
  next: ArchivistState,
): Promise<void> {
  const now = new Date().toISOString();
  const data = { chatId, ...next };
  if (current.revision === null) {
    await documents.create({
      id: stateDocId(chatId),
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: ARCHIVIST_STATE_DOC_KIND,
      name: current.name,
      description: "",
      data,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  await documents.update({
    id: stateDocId(chatId),
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: current.revision,
    name: current.name,
    description: "",
    data,
    updatedAt: now,
  });
}

/** Keep the chat's last Archivist runs for Activity. */
async function recordRun(documents: LorebookManagerDocumentStore, record: LmArchivistRunRecord): Promise<void> {
  // Best effort, like the retrieval runs: a failed Activity write never changes the run's outcome.
  try {
    await writeRun(documents, record);
  } catch (error) {
    getLorebookManagerRuntime().logger.warn("[lorebook-manager] Could not record a run: %s", error);
  }
}

async function writeRun(documents: LorebookManagerDocumentStore, record: LmArchivistRunRecord): Promise<void> {
  const id = runDocId(record.chatId);
  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  const previous = Array.isArray((existing?.data as { runs?: unknown } | undefined)?.runs)
    ? ((existing!.data as { runs: LmArchivistRunRecord[] }).runs ?? [])
    : [];
  const runs = [record, ...previous].slice(0, MAX_RECORDED_RUNS);
  if (!existing) {
    await documents.create({
      id,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: ARCHIVIST_RUN_DOC_KIND,
      name: `Chat ${record.chatId} Archivist runs`,
      description: "",
      data: { chatId: record.chatId, runs },
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
    data: { chatId: record.chatId, runs },
    updatedAt: record.at,
  });
}

export async function listArchivistRuns(): Promise<LmArchivistRunRecord[]> {
  const documents = getLorebookManagerRuntime().persistence.documents;
  const docs = await documents.list(LOREBOOK_MANAGER_PACKAGE_ID, ARCHIVIST_RUN_DOC_KIND);
  return docs
    .flatMap((doc) => {
      const runs = (doc.data as { runs?: unknown } | undefined)?.runs;
      return Array.isArray(runs) ? (runs as LmArchivistRunRecord[]) : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ── The run ──

export interface ArchivistOutcome {
  status: LmArchivistRunStatus;
  run: LmArchivistRunRecord | null;
  /** Settled messages are still past the watermark: the job runs again. */
  more?: boolean;
}

/** The messages the model can see: user and assistant, not hidden from the AI, not empty. */
function visibleMessages(messages: readonly LorebookManagerMessageRecord[]): LorebookManagerMessageRecord[] {
  return messages.filter((message) => {
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (parseExtra(message.extra).hiddenFromAI === true) return false;
    return Boolean((message.agentContent ?? message.content ?? "").trim());
  });
}

/** A message's text, capped so one huge message can't blow the window. */
const messageText = (message: LorebookManagerMessageRecord) =>
  (message.agentContent ?? message.content ?? "").trim().slice(0, MAX_WINDOW_CHARS);

/**
 * The messages past the watermark that fit the prompt, in chat order. With a watermark: the oldest ones, so nothing
 * is skipped (the rest waits for the next run). On a chat's first run: the newest ones, so an old chat's history
 * isn't archived in dozens of calls.
 */
function trimWindow(
  pending: readonly LorebookManagerMessageRecord[],
  fromOldest: boolean,
): LorebookManagerMessageRecord[] {
  const window: LorebookManagerMessageRecord[] = [];
  let chars = 0;
  for (let step = 0; step < pending.length && window.length < MAX_WINDOW_MESSAGES; step++) {
    const message = pending[fromOldest ? step : pending.length - 1 - step]!;
    const length = messageText(message).length;
    if (window.length > 0 && chars + length > MAX_WINDOW_CHARS) break;
    window.push(message);
    chars += length;
  }
  return fromOldest ? window : window.reverse();
}

export const ARCHIVIST_SYSTEM = [
  "You keep a roleplay's lorebook up to date. You read recent story messages and the lorebook entries they touch.",
  "Report only lasting facts these messages establish: who someone is or has become, what happened to them, where",
  "things and people are, relationships, possessions, places, factions, rules of the world.",
  "Skip moods, passing actions, dialogue, guesses and anything an entry already says.",
  "updates: new facts for an existing entry, by its id from <entries> or <directory>. Each fact is one short,",
  "self-contained sentence in narrator voice.",
  "creates: a new entry only for a named person, place, item, faction or idea that matters beyond this scene and is",
  "not in <entries> or <directory> under any name. content: 2-5 sentences of narrator prose. category: one of",
  `${CATEGORIES.join(", ")}. keys: 1-4 names or aliases it is called by.`,
  "Never invent. If nothing lasting happened, answer with empty lists.",
  'Answer with JSON only: {"updates": [{"id": "c1", "facts": ["..."]}], "creates": [{"name": "...", "category": "...",',
  '"content": "...", "keys": ["..."]}]}',
].join(" ");

function entryBlock(id: string, entry: LmEntryNode): string {
  const keys = entry.keys.slice(0, 8).join(", ");
  const content =
    entry.content.length > CANDIDATE_CONTENT_CHARS
      ? `${entry.content.slice(0, CANDIDATE_CONTENT_CHARS)}…`
      : entry.content;
  return `[${id}] ${entry.name} (${entry.tag || entry.family || "-"}) | keys: ${keys || "-"}\n${content.trim()}`;
}

export function archivistUserPrompt(
  candidates: readonly LmEntryNode[],
  directory: readonly LmEntryNode[],
  window: readonly LorebookManagerMessageRecord[],
): string {
  const entries = candidates.map((entry, index) => entryBlock(`c${index + 1}`, entry)).join("\n\n");
  const rows = directory.map(
    (entry, index) =>
      `d${index + 1} | ${entry.name} | ${entry.tag || entry.family || "-"} | ${entry.keys.slice(0, 4).join(", ") || "-"}`,
  );
  const messages = window
    .map((message) => `${message.role === "user" ? "Player" : "Story"}: ${messageText(message)}`)
    .join("\n\n");
  return [
    `<entries>\n${entries || "(none)"}\n</entries>`,
    `<directory>\nid | name | tag | keys\n${rows.join("\n") || "(none)"}\n</directory>`,
    `<messages>\n${messages}\n</messages>`,
  ].join("\n\n");
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

/** Names that are the same thing: equal once normalized, or one is the other plus whole words ("Kakashi Hatake"). */
export function sameName(a: string, b: string): boolean {
  const left = comparableFact(a);
  const right = comparableFact(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 4) return false;
  return longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`) || longer.includes(` ${shorter} `);
}

/** The Compendium book a new entry lands in: one whose category fits, else the first. */
function bookFor(category: Category, compendium: LmCompendium, payload: LmGraphPayload): string {
  const books = compendium.lorebookIds
    .map((id) => payload.lorebooks.find((book) => book.id === id))
    .filter((book): book is NonNullable<typeof book> => Boolean(book));
  const wanted = category === "character" ? ["character", "npc"] : category === "ability" ? ["spellbook"] : ["world"];
  return books.find((book) => wanted.includes(book.category))?.id ?? compendium.lorebookIds[0]!;
}

export async function runArchivist(
  chatId: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<ArchivistOutcome> {
  const startedAt = Date.now();
  const runtime = getLorebookManagerRuntime();
  const { persistence } = runtime;
  const documents = persistence.documents;
  const trigger: LmArchivistRunRecord["trigger"] = options.force ? "manual" : "auto";
  const compendium = compendiumForChat(chatId);
  const base = (status: LmArchivistRunStatus, detail?: string): LmArchivistRunRecord => ({
    at: new Date().toISOString(),
    chatId,
    compendiumId: compendium?.id ?? null,
    compendiumName: compendium?.name ?? null,
    status,
    trigger,
    messageCount: 0,
    candidateCount: 0,
    updates: 0,
    creates: 0,
    skipped: [],
    proposalIds: [],
    model: null,
    ms: Date.now() - startedAt,
    ...(detail ? { detail } : {}),
  });
  // Quiet outcomes are recorded only for Run now, so the user sees why nothing happened.
  const quiet = async (status: LmArchivistRunStatus, detail?: string): Promise<ArchivistOutcome> => {
    const run = options.force ? base(status, detail) : null;
    if (run) await recordRun(documents, run);
    return { status, run };
  };

  if (typeof persistence.listMessages !== "function") return quiet("unavailable", "This Engine can't read chats");
  const chat = typeof persistence.getChat === "function" ? await persistence.getChat(chatId) : null;
  if (!options.force && !agentAddedToChat(parseExtra(chat?.metadata))) return quiet("off");
  if (!compendium || compendium.lorebookIds.length === 0)
    return quiet("not_bound", "No Compendium is bound to this chat");
  const settings = await getSettings(documents);
  const archivist = resolveArchivistSettings(settings.archivist, compendium.overrides);
  if (archivist.mode === "off" && !options.force) return quiet("off");

  const messages = visibleMessages(await persistence.listMessages(chatId));
  if (!options.force && messages.at(-1)?.role === "user") return quiet("reply_pending");
  const settled = messages.slice(0, Math.max(0, messages.length - archivist.unreadMessages));

  const stored = await readState(documents, chatId);
  const { state } = stored;
  if (!options.force && state.failedAt && Date.now() - Date.parse(state.failedAt) < ARCHIVIST_FAILURE_COOLDOWN_MS) {
    return quiet("cooling_down");
  }
  let start = 0;
  if (state.lastMessageId) {
    const index = settled.findIndex((message) => message.id === state.lastMessageId);
    if (index >= 0) start = index + 1;
    else if (state.lastMessageAt) {
      // The watermark message is gone (deleted, rewound): carry on after its time.
      const after = settled.findIndex((message) => message.createdAt > state.lastMessageAt!);
      start = after >= 0 ? after : settled.length;
    }
  }
  const pending = settled.slice(start);
  if (pending.length === 0) return quiet("nothing_new", "No settled messages since the last run");
  const replies = pending.filter((message) => message.role === "assistant").length;
  if (!options.force && replies < archivist.everyNTurns) return quiet("not_due");

  const languageModels = runtime.languageModels;
  if (!languageModels) return quiet("unavailable", "This Engine has no language model host");
  const firstRun = !state.lastMessageId;
  const window = trimWindow(pending, !firstRun);
  const leftForNext = firstRun ? 0 : pending.length - window.length;
  const olderLeftOut = firstRun ? pending.length - window.length : 0;

  // Lookup: Stage 1 over the window, wide open, picks the entries these messages touch.
  const lorebookIds = new Set(compendium.lorebookIds);
  const characterIds = [...new Set([...compendium.characterIds, ...(chat?.characterIds ?? [])])];
  const personaId = chat?.personaId ?? null;
  const payload = await buildLorebookManagerGraphPayload({
    lorebookIds,
    characterIds: new Set(characterIds),
    personaIds: new Set(personaId ? [personaId] : []),
    onlyRequested: true,
    skipMentions: true,
  });
  const loreEntries = payload.nodes.filter(
    (node): node is LmEntryNode => node.nodeType === "lore" && lorebookIds.has(node.lorebookId),
  );
  const windowText = window.map(messageText).join("\n\n");
  const stage1 = simulateLorebookRetrieval(
    payload,
    {
      queryText: windowText,
      activeCharacterIds: chat?.characterIds ?? [],
      activePersonaId: personaId,
      tokenBudget: 1_000_000,
      maxOneHop: 6,
      maxTextHits: 15,
      respectBookBudgets: false,
      extraStopwords: compendium.retrievalSettings.extraStopwords,
      bm25Strictness: compendium.retrievalSettings.bm25Strictness,
    },
    lorebookIds,
  );
  const candidates = stage1.activated
    .map((item) => item.entry)
    .filter((entry) => entry.nodeType === "lore" && lorebookIds.has(entry.lorebookId))
    .slice(0, CANDIDATE_LIMIT);
  const candidateRefs = new Set(candidates.map((entry) => entry.ref));
  const directory = loreEntries.filter((entry) => !candidateRefs.has(entry.ref)).slice(0, DIRECTORY_LIMIT);
  const byShortId = new Map<string, LmEntryNode>([
    ...candidates.map((entry, index) => [`c${index + 1}`, entry] as const),
    ...directory.map((entry, index) => [`d${index + 1}`, entry] as const),
  ]);

  // Diff: one model call.
  const failed = async (detail: string, model: string | null): Promise<ArchivistOutcome> => {
    const run = { ...base("failed", detail), messageCount: window.length, candidateCount: candidates.length, model };
    await writeState(documents, chatId, stored, { ...state, failedAt: new Date().toISOString() });
    await recordRun(documents, run);
    return { status: "failed", run };
  };
  let modelName: string | null = null;
  let answer: unknown;
  try {
    const model = await languageModels.resolveForRequest({
      connectionId: archivist.connectionId,
      chatConnectionId: chat?.connectionId ?? null,
    });
    modelName = model.model;
    const completion = await model.chatComplete(
      [
        { role: "system", content: ARCHIVIST_SYSTEM },
        { role: "user", content: archivistUserPrompt(candidates, directory, window) },
      ],
      { temperature: 0.2, maxTokens: 1_500, signal: backgroundModelSignal(options.signal) },
    );
    if (options.signal?.aborted) return { status: "failed", run: null };
    if (completion.finishReason === "length") return failed("The model's answer was cut off", modelName);
    answer = completion.content ? safeParse(completion.content) : null;
  } catch (error) {
    if (options.signal?.aborted) return { status: "failed", run: null };
    return failed(error instanceof Error ? error.message.slice(0, 200) : String(error), modelName);
  }
  const parsed = asRecord(answer);
  if (!Array.isArray(parsed.updates) && !Array.isArray(parsed.creates)) {
    return failed("The model's answer wasn't readable", modelName);
  }

  const sourceMessageRefs = window.map((message) => ({
    messageId: message.id,
    swipeIndex: message.activeSwipeIndex ?? 0,
  }));
  const reason = `From ${window.length} ${window.length === 1 ? "message" : "messages"} of the chat`;
  const skipped: LmArchivistRunRecord["skipped"] = [];
  const proposalIds: string[] = [];
  let updates = 0;
  let creates = 0;
  const [pendingProposals, dismissedProposals] = await Promise.all([
    listProposals(documents, "pending"),
    listProposals(documents, "dismissed"),
  ]);
  const archivistPending = pendingProposals.filter((proposal) => proposal.source === "archivist");
  const archivistDismissed = dismissedProposals.filter((proposal) => proposal.source === "archivist");

  for (const raw of (Array.isArray(parsed.updates) ? parsed.updates : []).slice(0, MAX_UPDATES)) {
    const item = asRecord(raw);
    const shortId = cleanText(item.id, 12);
    const entry = byShortId.get(shortId);
    if (!entry) {
      skipped.push({ name: shortId || "?", why: "unknown entry" });
      continue;
    }
    if (entry.locked) {
      skipped.push({ name: entry.name, why: "locked" });
      continue;
    }
    const facts = (Array.isArray(item.facts) ? item.facts : [])
      .map((fact) => cleanText(fact, MAX_FACT_CHARS))
      .filter(Boolean)
      .slice(0, MAX_FACTS);
    const fresh = novelFacts(entry.content, facts);
    if (fresh.length === 0) {
      skipped.push({ name: entry.name, why: "already known" });
      continue;
    }
    const open = archivistPending.find(
      (proposal) => proposal.kind === "update_entry" && proposal.targetEntryId === entry.id,
    );
    if (open) {
      const folded = await appendProposalFacts(documents, open, fresh, sourceMessageRefs);
      if (folded) {
        proposalIds.push(folded.id);
        updates += 1;
        continue;
      }
    }
    const proposal = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: entry.lorebookId,
      targetEntryId: entry.id,
      entryName: entry.name,
      patch: { newFacts: fresh },
      reason,
      source: "archivist",
      chatId,
      sourceMessageRefs,
    });
    archivistPending.push(proposal);
    proposalIds.push(proposal.id);
    updates += 1;
  }

  // Only this Compendium's books: another Compendium may well need its own entry of the same name.
  const ownBooks = new Set(compendium.lorebookIds);
  const suggestedBefore = (name: string, list: readonly LmProposal[]) =>
    list.some(
      (proposal) =>
        proposal.kind === "create_entry" && ownBooks.has(proposal.lorebookId) && sameName(proposal.entryName, name),
    );
  for (const raw of (Array.isArray(parsed.creates) ? parsed.creates : []).slice(0, MAX_CREATES)) {
    const item = asRecord(raw);
    const name = cleanText(item.name, 80);
    const content = typeof item.content === "string" ? item.content.trim().slice(0, MAX_CREATE_CHARS) : "";
    if (!name || !content) {
      skipped.push({ name: name || "?", why: "empty" });
      continue;
    }
    if (suggestedBefore(name, archivistPending)) {
      skipped.push({ name, why: "already suggested" });
      continue;
    }
    if (suggestedBefore(name, archivistDismissed)) {
      skipped.push({ name, why: "dismissed before" });
      continue;
    }
    const rawCategory = cleanText(item.category, 20).toLowerCase();
    const category: Category = (CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as Category)
      : "concept";
    const keys = [
      ...new Set(
        (Array.isArray(item.keys) ? item.keys : [])
          .map((key) => cleanText(key, 60))
          .filter(Boolean)
          .slice(0, 4),
      ),
    ];
    const duplicate = loreEntries.find(
      (entry) =>
        sameName(entry.name, name) ||
        entry.keys.some((key) => sameName(key, name)) ||
        keys.some((key) => sameName(key, entry.name)),
    );
    // Until the Crawler writes real keys and a tag (B2), the name keeps a new entry findable in play.
    const proposal = await createProposal(documents, {
      kind: "create_entry",
      lorebookId: bookFor(category, compendium, payload),
      entryName: name,
      patch: { content, keys: keys.length > 0 ? keys : [name], tag: category },
      reason,
      source: "archivist",
      chatId,
      sourceMessageRefs,
      duplicateOfEntryId: duplicate?.id ?? null,
    });
    archivistPending.push(proposal);
    proposalIds.push(proposal.id);
    creates += 1;
  }

  // The first run skips what came before its window; later runs move on only past what they read.
  const last = firstRun ? settled.at(-1)! : window.at(-1)!;
  await writeState(documents, chatId, stored, {
    lastMessageId: last.id,
    lastMessageAt: last.createdAt,
    failedAt: null,
  });
  const note =
    leftForNext > 0
      ? `${leftForNext} more messages wait for the next run`
      : olderLeftOut > 0
        ? `First run: read the newest ${window.length}; ${olderLeftOut} older messages left out`
        : undefined;
  const run: LmArchivistRunRecord = {
    ...base("done", note),
    messageCount: window.length,
    candidateCount: candidates.length,
    updates,
    creates,
    skipped,
    proposalIds,
    model: modelName,
    ms: Date.now() - startedAt,
  };
  await recordRun(documents, run);
  runtime.logger.debug(
    "[lorebook-manager] Archivist chat %s: %d messages, %d candidates, %d updates, %d creates, %d skipped, %d ms",
    chatId,
    window.length,
    candidates.length,
    updates,
    creates,
    skipped.length,
    run.ms,
  );
  return { status: "done", run, more: leftForNext > 0 };
}
