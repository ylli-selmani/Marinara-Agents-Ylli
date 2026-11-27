import { representedCardIds } from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import { ENTITY_FAMILIES } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  LM_STUB_FIELDS,
  createSheetContent,
  sheetFields,
  sheetFieldEdits,
  type LmSheetOverrides,
} from "../../../../shared/src/features/agents/lorebook-manager/sheets.js";
import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import { resolveArchivistSettings } from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import type {
  LmArchivistBackfillJob,
  LmArchivistBackfillStatus,
  LmArchivistRunRecord,
  LmArchivistRunStatus,
  LmCompendium,
  LmEntryNode,
  LmGraphPayload,
  LmProposal,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { CompendiumStoreError, LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { crawlAfterArchivist } from "./crawler.js";
import { agentAddedToChat, compendiumForChat } from "./live-claims.js";
import { parseExtra } from "./live-retrieval.js";
import {
  getLorebookManagerRuntime,
  type LorebookManagerDocumentStore,
  type LorebookManagerMessageRecord,
  type LorebookManagerRuntimeHost,
} from "./package-runtime.js";
import {
  appendProposalFieldEdits,
  applyProposal,
  comparableFact,
  createProposal,
  listProposals,
} from "./proposals-store.js";
import { buildLorebookManagerGraphPayload } from "./routes.js";
import { getSettings } from "./settings-store.js";
import {
  ARCHIVIST_CATEGORIES,
  composePrompt,
} from "../../../../shared/src/features/agents/lorebook-manager/prompts.js";

// ── The Archivist: Lookup-then-Diff after the turn, in the background (Long-Term Memory's auto-import pattern). ──
// The contributor arms a job per chat; after a quiet period the job reads the settled messages past its watermark,
// looks up the entries they touch (Stage 1 over the window), and asks one model for new facts and new entries.
// Automatic follows the chat's Review Agent Outputs switch; other changes wait in Review.

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
const MAX_CREATES = 5;
const MAX_CREATE_CHARS = 2_000;
const MAX_RECORDED_RUNS = 50;
const MAX_PROCESSED_KEYS = 20_000;
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

type Category = (typeof ARCHIVIST_CATEGORIES)[number];

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
  for (const job of backfillJobs.values()) {
    if (job.status.status === "running") job.status.status = "stopped";
    job.controller.abort();
    running.push(job.running);
  }
  await Promise.all(running);
}

/** Package activation: jobs may be armed again. */
export function resumeArchivist(): void {
  stopped = false;
}

// ── Read keys, the fixed forward boundary, and the last normal-run watermark. ──

interface ArchivistState {
  lastMessageId: string | null;
  lastMessageAt: string | null;
  failedAt: string | null;
  processed: string[];
  forwardFrom: { id: string; at: string } | null;
}

const stateDocId = (chatId: string) => `archivist_state:${chatId}`;
const runDocId = (chatId: string) => `archivist_run:${chatId}`;
const messageKey = (message: LorebookManagerMessageRecord) => `${message.id}:${message.activeSwipeIndex ?? 0}`;

function pruneProcessed(keys: readonly string[], messages: readonly LorebookManagerMessageRecord[]): string[] {
  const ids = new Set(messages.map((message) => message.id));
  return [...new Set(keys)].filter((key) => ids.has(key.slice(0, key.lastIndexOf(":")))).slice(-MAX_PROCESSED_KEYS);
}

async function readState(
  documents: LorebookManagerDocumentStore,
  chatId: string,
  messages: readonly LorebookManagerMessageRecord[] | (() => Promise<LorebookManagerMessageRecord[]>),
): Promise<{
  state: ArchivistState;
  revision: number | null;
  name: string;
  messages: readonly LorebookManagerMessageRecord[];
}> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, stateDocId(chatId));
  const data = (doc?.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  // Read messages after the document when writing: a concurrent read may refer to a newly added message.
  const allMessages = typeof messages === "function" ? await messages() : messages;
  const boundary = asRecord(data.forwardFrom);
  const state: ArchivistState = {
    lastMessageId: text(data.lastMessageId),
    lastMessageAt: text(data.lastMessageAt),
    failedAt: text(data.failedAt),
    processed: Array.isArray(data.processed)
      ? data.processed.filter((key): key is string => typeof key === "string")
      : [],
    forwardFrom:
      text(boundary.id) && typeof boundary.at === "string"
        ? { id: boundary.id as string, at: boundary.at as string }
        : null,
  };
  if (!Array.isArray(data.processed) && state.lastMessageId) {
    const log = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, runDocId(chatId));
    const runs = (log?.data as { runs?: LmArchivistRunRecord[] } | undefined)?.runs ?? [];
    // Legacy logs kept only 20 runs; migration can recover only the messages those runs counted.
    const count = runs.reduce((sum, run) => sum + (run.status === "done" ? run.messageCount : 0), 0);
    if (count === 0) {
      // Even if Read behind rose or the message became hidden, keep the watermark's exact key and boundary.
      const watermark = allMessages.find((message) => message.id === state.lastMessageId);
      state.processed = watermark ? [messageKey(watermark)] : [];
      state.forwardFrom = { id: state.lastMessageId, at: watermark?.createdAt ?? state.lastMessageAt ?? "" };
    } else {
      const visible = visibleMessages(allMessages);
      let end = visible.findIndex((message) => message.id === state.lastMessageId);
      if (end < 0 && state.lastMessageAt) {
        end = visible.findLastIndex((message) => message.createdAt <= state.lastMessageAt!);
      }
      const read = visible.slice(Math.max(0, end + 1 - count), end + 1);
      state.processed = read.map(messageKey);
      const first = read[0];
      state.forwardFrom = first
        ? { id: first.id, at: first.createdAt }
        : { id: state.lastMessageId, at: state.lastMessageAt ?? "" };
    }
  }
  state.processed = pruneProcessed(state.processed, allMessages);
  return {
    state,
    revision: doc ? doc.revision : null,
    name: doc?.name ?? `Archivist state for chat ${chatId}`,
    messages: allMessages,
  };
}

/** Apply the change again on a revision conflict, preserving concurrent reads and the fixed forward boundary. */
async function writeState(
  documents: LorebookManagerDocumentStore,
  chatId: string,
  listMessages: () => Promise<LorebookManagerMessageRecord[]>,
  change: Partial<ArchivistState>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readState(documents, chatId, listMessages);
    const next = { ...current.state, ...change };
    next.processed = pruneProcessed([...current.state.processed, ...(change.processed ?? [])], current.messages);
    next.forwardFrom = current.state.forwardFrom ?? change.forwardFrom ?? null;
    // Re-reading a swipe must not move the normal watermark backwards.
    if (current.state.lastMessageAt && next.lastMessageAt && current.state.lastMessageAt > next.lastMessageAt) {
      next.lastMessageId = current.state.lastMessageId;
      next.lastMessageAt = current.state.lastMessageAt;
    }
    const now = new Date().toISOString();
    const data = { chatId, ...next };
    if (current.revision === null) {
      try {
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
      } catch (error) {
        if (!(await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, stateDocId(chatId)))) throw error;
        continue;
      }
    }
    const updated = await documents.update({
      id: stateDocId(chatId),
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      expectedRevision: current.revision,
      name: current.name,
      description: "",
      data,
      updatedAt: now,
    });
    if (updated) return;
  }
  throw new Error("Archivist state kept changing; reads were not saved");
}

/** Split by the boundary's position, falling back to its timestamp when the message was deleted. */
function unreadMessages(
  state: ArchivistState,
  messages: readonly LorebookManagerMessageRecord[],
  allMessages: readonly LorebookManagerMessageRecord[],
  mode: "normal" | "backfill",
) {
  const processed = new Set(state.processed);
  const boundary = state.forwardFrom;
  const index = boundary ? allMessages.findIndex((message) => message.id === boundary.id) : -1;
  const forwardIds = index >= 0 ? new Set(allMessages.slice(index).map((message) => message.id)) : null;
  return messages.filter((message) => {
    const forward = !boundary || (forwardIds ? forwardIds.has(message.id) : message.createdAt >= boundary.at);
    return !processed.has(messageKey(message)) && (mode === "normal" ? forward : Boolean(boundary) && !forward);
  });
}

/** Keep the chat's last Archivist runs for Activity. */
async function recordRun(
  documents: LorebookManagerDocumentStore,
  record: LmArchivistRunRecord,
  logger: LorebookManagerRuntimeHost["logger"],
): Promise<void> {
  // Best effort, like the retrieval runs: a failed Activity write never changes the run's outcome.
  try {
    await writeRun(documents, record);
  } catch (error) {
    logger.warn("[lorebook-manager] Could not record a run: %s", error);
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
  /** Unprocessed settled messages remain in this mode: the job runs again. */
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

/**
 * Read Behind: the messages before the last `readBehind` AI replies. Those replies, and what follows them, can still be
 * swiped or regenerated, so they never write lore. 0 reads up to the newest reply.
 */
export function settledMessages(
  messages: readonly LorebookManagerMessageRecord[],
  readBehind: number,
): LorebookManagerMessageRecord[] {
  if (readBehind <= 0) return [...messages];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant" && ++seen === readBehind) return messages.slice(0, index);
  }
  return [];
}

/** A message's text, capped so one huge message can't blow the window. */
const messageText = (message: LorebookManagerMessageRecord) =>
  (message.agentContent ?? message.content ?? "").trim().slice(0, MAX_WINDOW_CHARS);

/**
 * The unprocessed messages that fit the prompt, in chat order. With a forward boundary: oldest first, so nothing
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

/** The built-in prompt as sent (its text is in shared prompts.ts; Settings → Prompts can edit the instructions). */
export const ARCHIVIST_SYSTEM = composePrompt("archivist");

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
  sheets?: LmSheetOverrides,
  stubCardNames: ReadonlyMap<string, string> = new Map(),
): string {
  const entries = candidates
    .map((entry, index) => {
      const name = stubCardNames.get(entry.ref);
      return (
        entryBlock(`c${index + 1}`, entry) +
        (name
          ? `\nstub of the ${name} card: write only its current state here (the card holds the rest); never create a separate entry for ${name}`
          : "")
      );
    })
    .join("\n\n");
  const rows = directory.map(
    (entry, index) =>
      `d${index + 1} | ${entry.name} | ${entry.tag || entry.family || "-"} | ${entry.keys.slice(0, 4).join(", ") || "-"}`,
  );
  const messages = window
    .map((message) => `${message.role === "user" ? "Player" : "Story"}: ${messageText(message)}`)
    .join("\n\n");
  const templates = ENTITY_FAMILIES.map(
    (family) => `${family} sheet: ${sheetFields(family, sheets).join(", ") || "prose"}`,
  );
  const entrySheets = candidates.map(
    (entry, index) =>
      `c${index + 1} sheet: ${(representedCardIds(entry.relationships).length ? LM_STUB_FIELDS : sheetFields(entry.inferredFamily ?? entry.family, sheets)).join(", ") || "prose"}`,
  );
  return [
    `<sheets>\n${[...templates, ...entrySheets].join("\n")}\n</sheets>`,
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
  options: {
    signal?: AbortSignal;
    force?: boolean;
    mode?: "normal" | "backfill";
    runtime?: LorebookManagerRuntimeHost;
  } = {},
): Promise<ArchivistOutcome> {
  const startedAt = Date.now();
  if (options.signal?.aborted) return { status: "failed", run: null };
  const runtime = options.runtime ?? getLorebookManagerRuntime();
  const backfill = options.mode === "backfill";
  const force = options.force || backfill;
  const { persistence } = runtime;
  const documents = persistence.documents;
  const trigger: LmArchivistRunRecord["trigger"] = backfill ? "backfill" : options.force ? "manual" : "auto";
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
  const aborted = (): ArchivistOutcome => ({ status: "failed", run: null });
  // Manual outcomes are recorded so the user sees why nothing happened.
  const quiet = async (status: LmArchivistRunStatus, detail?: string): Promise<ArchivistOutcome> => {
    if (options.signal?.aborted) return aborted();
    const run = force ? base(status, detail) : null;
    if (run) await recordRun(documents, run, runtime.logger);
    return { status, run };
  };

  if (typeof persistence.listMessages !== "function") return quiet("unavailable", "This Engine can't read chats");
  const chat = typeof persistence.getChat === "function" ? await persistence.getChat(chatId) : null;
  if (!force && !agentAddedToChat(parseExtra(chat?.metadata))) return quiet("off");
  if (!compendium || compendium.lorebookIds.length === 0)
    return quiet("not_bound", "No Compendium is bound to this chat");
  const settings = await getSettings(documents);
  const archivist = resolveArchivistSettings(settings.archivist, compendium.overrides);
  if (archivist.mode === "off" && !force) return quiet("off");

  const allMessages = await persistence.listMessages(chatId);
  const messages = visibleMessages(allMessages);
  if (!force && messages.at(-1)?.role === "user") return quiet("reply_pending");
  const settled = settledMessages(messages, archivist.readBehind);

  const stored = await readState(documents, chatId, allMessages);
  const { state } = stored;
  if (!force && state.failedAt && Date.now() - Date.parse(state.failedAt) < ARCHIVIST_FAILURE_COOLDOWN_MS) {
    return quiet("cooling_down");
  }
  const pending = unreadMessages(state, settled, allMessages, backfill ? "backfill" : "normal");
  if (pending.length === 0) return quiet("nothing_new", "No settled messages since the last run");
  const replies = pending.filter((message) => message.role === "assistant").length;
  if (!force && replies < archivist.everyNTurns) return quiet("not_due");

  const languageModels = runtime.languageModels;
  if (!languageModels) return quiet("unavailable", "This Engine has no language model host");
  const firstRun = !backfill && !state.forwardFrom;
  const window = trimWindow(pending, !firstRun);
  const leftForNext = firstRun ? 0 : pending.length - window.length;
  const olderLeftOut = firstRun ? pending.length - window.length : 0;

  if (options.signal?.aborted) return aborted();

  // Lookup: Stage 1 over the window, wide open, picks the entries these messages touch.
  const lorebookIds = new Set(compendium.lorebookIds);
  const characterIds = [...new Set([...compendium.characterIds, ...(chat?.characterIds ?? [])])];
  const personaId = chat?.personaId ?? null;
  const payload = await buildLorebookManagerGraphPayload(
    {
      lorebookIds,
      characterIds: new Set(characterIds),
      personaIds: new Set(personaId ? [personaId] : []),
      onlyRequested: true,
      skipMentions: true,
    },
    runtime,
  );
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
  const activeCards = payload.nodes.filter(
    (node) => node.nodeType === "character" && chat?.characterIds.includes(node.id),
  );
  const stubCardNames = new Map<string, string>();
  for (const entry of loreEntries) {
    const ids = representedCardIds(entry.relationships);
    const names = activeCards.filter((card) => ids.includes(card.id)).map((card) => card.name);
    if (names.length) stubCardNames.set(entry.ref, names.join(", "));
  }
  const enabledBooks = new Set(payload.lorebooks.filter((book) => book.enabled).map((book) => book.id));
  const stubs = loreEntries
    .filter((entry) => entry.enabled && enabledBooks.has(entry.lorebookId) && stubCardNames.has(entry.ref))
    .slice(0, 5);
  const candidates = [
    ...new Map(
      [...stubs, ...stage1.activated.map((item) => item.entry).filter((entry) => !stubCardNames.has(entry.ref))].map(
        (entry) => [entry.ref, entry],
      ),
    ).values(),
  ].slice(0, CANDIDATE_LIMIT);
  const candidateRefs = new Set(candidates.map((entry) => entry.ref));
  const directory = loreEntries.filter((entry) => !candidateRefs.has(entry.ref)).slice(0, DIRECTORY_LIMIT);
  const byShortId = new Map<string, LmEntryNode>([
    ...candidates.map((entry, index) => [`c${index + 1}`, entry] as const),
  ]);

  // Diff: one model call.
  const failed = async (detail: string, model: string | null): Promise<ArchivistOutcome> => {
    if (options.signal?.aborted) return aborted();
    const run = { ...base("failed", detail), messageCount: window.length, candidateCount: candidates.length, model };
    if (!backfill)
      await writeState(documents, chatId, () => persistence.listMessages!(chatId), {
        failedAt: new Date().toISOString(),
      });
    if (options.signal?.aborted) return aborted();
    await recordRun(documents, run, runtime.logger);
    return { status: "failed", run };
  };
  if (options.signal?.aborted) return aborted();
  let modelName: string | null = null;
  let answer: unknown;
  try {
    const model = await languageModels.resolveForRequest({
      connectionId: archivist.connectionId,
      chatConnectionId: chat?.connectionId ?? null,
    });
    if (options.signal?.aborted) return aborted();
    modelName = model.model;
    const completion = await model.chatComplete(
      [
        { role: "system", content: composePrompt("archivist", settings.prompts) },
        { role: "user", content: archivistUserPrompt(candidates, directory, window, settings.sheets, stubCardNames) },
      ],
      {
        ...(archivist.temperature === null ? {} : { temperature: archivist.temperature }),
        maxTokens: archivist.maxTokens,
        signal: backgroundModelSignal(options.signal),
      },
    );
    if (options.signal?.aborted) return aborted();
    if (completion.finishReason === "length") {
      return failed("The model's answer was cut off: raise Max tokens in Settings → Archivist", modelName);
    }
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
  // Re-read after the model call: approval may have been enabled while it was thinking.
  const currentChat = typeof persistence.getChat === "function" ? await persistence.getChat(chatId) : null;
  const automatic =
    archivist.mode === "automatic" &&
    currentChat !== null &&
    parseExtra(currentChat.metadata).agentWriteApprovalRequired !== true;
  const handleProposal = async (proposal: LmProposal) => {
    proposalIds.push(proposal.id);
    if (options.signal?.aborted || !automatic || proposal.duplicateOfEntryId) return;
    try {
      const applied = await applyProposal(runtime, proposal.id, undefined, undefined, "automatic");
      if (!options.signal?.aborted) void crawlAfterArchivist(applied);
    } catch (error) {
      // A refused write stays pending so Review can explain and retry it.
      skipped.push({ name: proposal.entryName, why: error instanceof Error ? error.message : "Could not apply" });
    }
  };

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
    const open = archivistPending.find(
      (proposal) => proposal.kind === "update_entry" && proposal.targetEntryId === entry.id,
    );
    const fresh = sheetFieldEdits(
      entry.content,
      representedCardIds(entry.relationships).length
        ? LM_STUB_FIELDS
        : sheetFields(entry.inferredFamily ?? entry.family, settings.sheets),
      item.fields,
      Boolean(open),
    ).filter(
      (edit) =>
        !representedCardIds(entry.relationships).length ||
        LM_STUB_FIELDS.some((field) => field.toLowerCase() === edit.field.toLowerCase()),
    );
    if (fresh.length === 0) {
      skipped.push({ name: entry.name, why: "already known" });
      continue;
    }
    if (options.signal?.aborted) return aborted();
    if (open) {
      const folded = await appendProposalFieldEdits(documents, open, fresh, sourceMessageRefs);
      if (folded) {
        await handleProposal(folded);
        updates += 1;
        continue;
      }
    }
    if (options.signal?.aborted) return aborted();
    const proposal = await createProposal(documents, {
      kind: "update_entry",
      lorebookId: entry.lorebookId,
      targetEntryId: entry.id,
      entryName: entry.name,
      patch: { fieldEdits: fresh },
      reason,
      source: "archivist",
      chatId,
      sourceMessageRefs,
    });
    archivistPending.push(proposal);
    await handleProposal(proposal);
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
    const rawCategory = cleanText(item.category, 20).toLowerCase();
    const category: Category = (ARCHIVIST_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as Category)
      : "concept";
    const card =
      category === "character" &&
      activeCards.find((card) =>
        [card.name, ...(card.nodeType === "character" ? card.aliases : [])].some(
          (cardName) => comparableFact(name) === comparableFact(cardName),
        ),
      );
    if (card) {
      skipped.push({
        name,
        why: loreEntries.some((entry) => representedCardIds(entry.relationships).includes(card.id))
          ? "card has a stub"
          : "card has no stub yet",
      });
      continue;
    }
    const template = sheetFields(category, settings.sheets);
    const content =
      template.length === 0
        ? typeof item.content === "string"
          ? item.content.trim().slice(0, MAX_CREATE_CHARS)
          : ""
        : createSheetContent(template, item.fields);
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
    if (options.signal?.aborted) return aborted();
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
    await handleProposal(proposal);
    creates += 1;
  }

  if (options.signal?.aborted) return aborted();
  const last = window.at(-1)!;
  await writeState(documents, chatId, () => persistence.listMessages!(chatId), {
    processed: window.map(messageKey),
    ...(!backfill
      ? {
          lastMessageId: last.id,
          lastMessageAt: last.createdAt,
          failedAt: null,
          forwardFrom: { id: window[0]!.id, at: window[0]!.createdAt },
        }
      : {}),
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
  if (options.signal?.aborted) return aborted();
  await recordRun(documents, run, runtime.logger);
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

// Backfill jobs live only in memory: a restart cannot leave a persisted running flag.
interface BackfillJob {
  status: LmArchivistBackfillJob;
  controller: AbortController;
  running?: Promise<void>;
}
const backfillJobs = new Map<string, BackfillJob>();

async function olderUnreadMessages(chatId: string, runtime: LorebookManagerRuntimeHost) {
  const compendium = compendiumForChat(chatId);
  const settings = await getSettings(runtime.persistence.documents);
  const archivist = compendium
    ? resolveArchivistSettings(settings.archivist, compendium.overrides)
    : settings.archivist;
  const messages = await runtime.persistence.listMessages!(chatId);
  const settled = settledMessages(visibleMessages(messages), archivist.readBehind);
  const { state } = await readState(runtime.persistence.documents, chatId, messages);
  return { pending: unreadMessages(state, settled, messages, "backfill"), state };
}

export async function getArchivistBackfillStatus(chatId: string): Promise<LmArchivistBackfillStatus> {
  const runtime = getLorebookManagerRuntime();
  const pending =
    typeof runtime.persistence.listMessages === "function" ? (await olderUnreadMessages(chatId, runtime)).pending : [];
  let windowsEstimated = 0;
  for (let start = 0; start < pending.length;) {
    start += trimWindow(pending.slice(start), true).length;
    windowsEstimated += 1;
  }
  return { olderUnread: pending.length, windowsEstimated, job: backfillJobs.get(chatId)?.status ?? null };
}

export function startArchivistBackfill(chatId: string): LmArchivistBackfillJob {
  if (backfillJobs.get(chatId)?.status.status === "running")
    throw new CompendiumStoreError("Backfill is already running for this chat", 409);
  const runtime = getLorebookManagerRuntime();
  if (stopped) throw new CompendiumStoreError("The Archivist is stopped", 409);
  const compendium = compendiumForChat(chatId);
  if (!compendium || compendium.lorebookIds.length === 0)
    throw new CompendiumStoreError("No Compendium is bound to this chat", 400);
  if (!runtime.languageModels) throw new CompendiumStoreError("This Engine has no language model host", 501);
  if (typeof runtime.persistence.listMessages !== "function")
    throw new CompendiumStoreError("This Engine can't read chats", 501);
  const job: BackfillJob = {
    status: { status: "running", startedAt: new Date().toISOString(), windowsDone: 0 },
    controller: new AbortController(),
  };
  backfillJobs.set(chatId, job);
  const { signal } = job.controller;
  // Capture the runtime before returning: deactivation unbinds the global runtime immediately.
  job.running = (async () => {
    try {
      while (!signal.aborted && job.status.windowsDone < 40) {
        // Each window joins the queue separately, letting Run now and the Crawler take their turn.
        const result = await runInBackgroundQueue(async () => {
          if (signal.aborted) return null;
          const before = await olderUnreadMessages(chatId, runtime);
          if (signal.aborted || before.pending.length === 0) return null;
          const windowStartedAt = Date.now();
          let outcome: ArchivistOutcome;
          try {
            outcome = await runArchivist(chatId, { mode: "backfill", signal, runtime });
          } catch (error) {
            if (signal.aborted) return null;
            const run: LmArchivistRunRecord = {
              at: new Date().toISOString(),
              chatId,
              compendiumId: compendium.id,
              compendiumName: compendium.name,
              status: "failed",
              trigger: "backfill",
              messageCount: trimWindow(before.pending, true).length,
              candidateCount: 0,
              updates: 0,
              creates: 0,
              skipped: [],
              proposalIds: [],
              model: null,
              ms: Date.now() - windowStartedAt,
              detail: error instanceof Error ? error.message : String(error),
            };
            await recordRun(runtime.persistence.documents, run, runtime.logger);
            outcome = { status: "failed", run };
          }
          if (signal.aborted) return null;
          const after = await olderUnreadMessages(chatId, runtime);
          const previous = new Set(before.state.processed);
          return {
            outcome,
            remaining: after.pending.length,
            added: after.state.processed.some((key) => !previous.has(key)),
          };
        });
        if (signal.aborted) break;
        if (!result) {
          job.status.status = "done";
          return;
        }
        if (result.outcome.status === "nothing_new" && result.remaining === 0) {
          job.status.status = "done";
          return;
        }
        if (result.outcome.status !== "done") {
          job.status.status = "failed";
          job.status.detail = result.outcome.run?.detail || "Backfill failed";
          return;
        }
        job.status.windowsDone += 1;
        if (result.remaining === 0) {
          job.status.status = "done";
          return;
        }
        if (!result.added) {
          job.status.status = "failed";
          job.status.detail = "Backfill stopped because the window added no new reads";
          return;
        }
      }
      if (signal.aborted) return;
      const remaining = await olderUnreadMessages(chatId, runtime);
      if (signal.aborted) return;
      job.status.status = "done";
      if (remaining.pending.length > 0)
        job.status.detail = "Stopped at the safety cap of 40 windows; Backfill again to continue";
    } catch (error) {
      job.status.status = signal.aborted ? "stopped" : "failed";
      if (!signal.aborted)
        job.status.detail = (error instanceof Error ? error.message : String(error)) || "Backfill failed";
    }
  })();
  return { ...job.status };
}

/** Idempotent; an in-flight model call may finish or honor the abort before the job settles. */
export function stopArchivistBackfill(chatId: string): LmArchivistBackfillJob | null {
  const job = backfillJobs.get(chatId);
  if (job?.status.status === "running") {
    job.status.status = "stopped";
    job.controller.abort();
  }
  return job?.status ?? null;
}
