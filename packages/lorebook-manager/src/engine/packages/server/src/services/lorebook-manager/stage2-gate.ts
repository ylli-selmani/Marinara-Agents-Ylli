import { createHash } from "node:crypto";
import type {
  LmCompendiumRetrievalSettings,
  LmGateRunInfo,
  LmRetrievalActivatedItem,
  LmRetrievalResult,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { getLorebookManagerRuntime } from "./package-runtime.js";

/** What the package asks the Engine for (its cap). The gate keeps well inside it with its own deadline. */
export const LIVE_CONTRIBUTOR_TIMEOUT_MS = 5_000;
/** The gate's own deadline. It must always fire before the Engine's, or the Engine rescans and hides the package. */
export const GATE_DEADLINE_MS = 3_500;
/** Room left for Stage 1, formatting and the Engine's own work after the gate. */
const GATE_DEADLINE_MARGIN_MS = 500;
/** Too little time left to ask anything: skip the gate and keep Stage 1. */
const GATE_MIN_BUDGET_MS = 300;
/** Half the user's default per-turn Decision limit (32): the host rejects a request above the user's limit. */
export const GATE_MAX_DECISION_QUESTIONS = 16;
const MAX_QUESTION_CHARS = 500;
const SUMMARY_CHARS = 240;
const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_CACHE_MAX = 100;

export interface GateQueryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GateContext {
  chatId: string;
  mode: string;
  /** The same messages Stage 1 matched, oldest first. */
  queryMessages: readonly GateQueryMessage[];
  chatConnectionId: string | null;
  /** When the contributor started (`Date.now()`), so the gate's deadline counts the time already spent. */
  startedAt: number;
}

export interface GateOutcome {
  result: LmRetrievalResult;
  info: LmGateRunInfo | null;
}

/** Shared words (BM25) and meaning (similarity) are guesses; keys, constants, location and links are not. */
const LOOSE_REASONS = new Set(["bm25", "semantic"]);

/**
 * The uncertain tail: entries found only by shared words or by meaning, nothing stronger. Keyword, constant, location
 * and card hits are trusted and never checked. (3c-2 first checked meaning-only picks, but almost every meaning match
 * also shares a word, so the gate never had anything to check; the noise Ylli saw was shared-word hits.)
 */
export function gateCandidates(result: LmRetrievalResult): LmRetrievalActivatedItem[] {
  return result.activated.filter(
    (item) => item.reasons.length > 0 && item.reasons.every((reason) => LOOSE_REASONS.has(reason.kind)),
  );
}

/** 1-hop entries that came only through seeds the gate turned down lose their reason to be there too. */
function orphanedByRejection(result: LmRetrievalResult, rejected: ReadonlySet<string>): string[] {
  return result.activated
    .filter(
      (item) =>
        item.reasons.length > 0 &&
        item.reasons.every((reason) => reason.kind === "graph_1hop") &&
        item.viaRefs.length > 0 &&
        item.viaRefs.every((ref) => rejected.has(ref)),
    )
    .map((item) => item.entry.ref);
}

function summaryOf(item: LmRetrievalActivatedItem): string {
  const text = (item.entry.description.trim() || item.entry.content.trim()).replace(/\s+/gu, " ");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

// ── Verdict cache: Peek, the turn after it and every swipe of the same query get the same answer. ──

interface CachedVerdict {
  at: number;
  rejected: string[];
  model: string | null;
}

const verdicts = new Map<string, CachedVerdict>();

function verdictKey(
  context: GateContext,
  mode: LmCompendiumRetrievalSettings["stage2Gate"],
  connectionId: string | null,
  refs: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([context.chatId, context.mode, mode, connectionId, context.queryMessages, [...refs].sort()]),
  );
  return hash.digest("hex");
}

function readVerdict(key: string, now: number): CachedVerdict | null {
  const hit = verdicts.get(key);
  if (!hit) return null;
  if (now - hit.at > VERDICT_TTL_MS) {
    verdicts.delete(key);
    return null;
  }
  return hit;
}

function writeVerdict(key: string, verdict: CachedVerdict): void {
  verdicts.delete(key);
  verdicts.set(key, verdict);
  while (verdicts.size > VERDICT_CACHE_MAX) {
    const oldest = verdicts.keys().next().value;
    if (oldest === undefined) break;
    verdicts.delete(oldest);
  }
}

export function resetGateVerdicts(): void {
  verdicts.clear();
}

// ── The two checkers. Each returns the refs to drop; anything it can't judge stays. ──

class GateTimeout extends Error {}

function withGateDeadline<T>(work: (signal: AbortSignal) => Promise<T>, budgetMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GateTimeout(`gate exceeded ${budgetMs} ms`));
    }, budgetMs);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

function sceneText(context: GateContext): string {
  return context.queryMessages
    .map((message) => `${message.role === "user" ? "User" : "Story"}: ${message.content}`)
    .join("\n\n");
}

async function decisionRejects(
  candidates: readonly LmRetrievalActivatedItem[],
  context: GateContext,
  signal: AbortSignal,
): Promise<{ rejected: string[]; model: string | null } | "unavailable"> {
  const decisions = getLorebookManagerRuntime().decisions;
  if (!decisions) return "unavailable";
  const asked = candidates.slice(0, GATE_MAX_DECISION_QUESTIONS);
  const questions = asked.map((item, index) => {
    const question = `Is the lore entry "${item.entry.name}" relevant to what is happening in the story right now? Entry: ${summaryOf(item)}`;
    return {
      id: `e${index + 1}`,
      question: question.length > MAX_QUESTION_CHARS ? `${question.slice(0, MAX_QUESTION_CHARS - 1)}…` : question,
    };
  });
  const result = await decisions.evaluate({
    messages: context.queryMessages.map((message) => ({ role: message.role, content: message.content })),
    questions,
    signal,
  });
  if (!result) return "unavailable";
  const rejected: string[] = [];
  asked.forEach((item, index) => {
    const answer = result.answers[`e${index + 1}`];
    // A missing answer keeps the entry: the gate only removes what the model actually turned down.
    if (typeof answer === "number" && answer < result.threshold) rejected.push(item.entry.ref);
  });
  return { rejected, model: result.model };
}

const LIBRARIAN_SYSTEM = [
  "You are the Librarian of a roleplay's lorebook. Some entries were found only because they share words or meaning",
  "with the latest messages, and some of those are noise. Keep an entry only if the story right now involves it, or the",
  "writer would plainly need it for the next reply. When unsure, keep it.",
  'Answer with JSON only: {"keep": ["e1", "e3"]}. Use only the ids listed.',
].join(" ");

async function librarianRejects(
  candidates: readonly LmRetrievalActivatedItem[],
  context: GateContext,
  connectionId: string | null,
  signal: AbortSignal,
): Promise<{ rejected: string[]; model: string | null } | "unavailable" | "unreadable"> {
  const runtime = getLorebookManagerRuntime();
  const languageModels = runtime.languageModels;
  if (!languageModels) return "unavailable";
  const model = await languageModels.resolveForRequest({
    connectionId,
    chatConnectionId: context.chatConnectionId,
  });
  const rows = candidates.map((item, index) => {
    const keys = item.entry.keys.slice(0, 6).join(", ");
    return `e${index + 1} | ${item.entry.name} | ${item.entry.tag || "-"} | ${keys || "-"} | ${summaryOf(item)}`;
  });
  const completion = await model.chatComplete(
    [
      { role: "system", content: LIBRARIAN_SYSTEM },
      {
        role: "user",
        content: `<scene>\n${sceneText(context)}\n</scene>\n\n<candidates>\nid | name | tag | keys | summary\n${rows.join("\n")}\n</candidates>`,
      },
    ],
    { temperature: 0, maxTokens: 300, signal },
  );
  const parsed = completion.content ? safeParse(completion.content) : null;
  const keep =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { keep?: unknown }).keep : undefined;
  if (!Array.isArray(keep)) return "unreadable";
  const kept = new Set(keep.filter((id): id is string => typeof id === "string").map((id) => id.trim()));
  return {
    rejected: candidates.filter((_item, index) => !kept.has(`e${index + 1}`)).map((item) => item.entry.ref),
    model: model.model,
  };
}

function safeParse(raw: string): unknown {
  const json = getLorebookManagerRuntime().json;
  try {
    return json ? json.parseJsonish(raw) : JSON.parse(raw);
  } catch {
    return null;
  }
}

function withoutRejected(result: LmRetrievalResult, rejected: ReadonlySet<string>): LmRetrievalResult {
  if (rejected.size === 0) return result;
  const gone = new Set([...rejected, ...orphanedByRejection(result, rejected)]);
  const activated = result.activated.filter((item) => !gone.has(item.entry.ref));
  return { ...result, activated, totalTokens: activated.reduce((sum, item) => sum + item.tokens, 0) };
}

/**
 * Stage 2: check the loose picks (shared words or meaning only) with the Compendium's gate, at most one model call. Fails open: whatever goes
 * wrong, the entry stays, so the gate can cost noise but never lore.
 */
export async function runStage2Gate(
  settings: Pick<LmCompendiumRetrievalSettings, "stage2Gate" | "librarianConnectionId">,
  result: LmRetrievalResult,
  context: GateContext,
): Promise<GateOutcome> {
  const mode = settings.stage2Gate;
  if (mode === "instant") return { result, info: null };
  const candidates = gateCandidates(result);
  const base = { mode, checked: candidates.length, dropped: [] as LmGateRunInfo["dropped"], ms: 0 };
  if (candidates.length === 0) return { result, info: { ...base, status: "nothing_to_check" } };

  const connectionId = mode === "librarian" ? settings.librarianConnectionId : null;
  const refs = candidates.map((item) => item.entry.ref);
  const key = verdictKey(context, mode, connectionId, refs);
  const started = Date.now();
  const finish = (
    status: LmGateRunInfo["status"],
    rejectedRefs: readonly string[] = [],
    extra: Partial<LmGateRunInfo> = {},
  ): GateOutcome => {
    const rejected = new Set(rejectedRefs);
    const orphans = new Set(orphanedByRejection(result, rejected));
    return {
      result: withoutRejected(result, rejected),
      info: {
        ...base,
        status,
        ms: Date.now() - started,
        dropped: result.activated
          .filter((item) => rejected.has(item.entry.ref) || orphans.has(item.entry.ref))
          .map((item) => ({ ref: item.entry.ref, name: item.entry.name })),
        ...extra,
      },
    };
  };

  const cached = readVerdict(key, started);
  if (cached) return finish("cached", cached.rejected, cached.model ? { model: cached.model } : {});

  const budget = Math.min(
    GATE_DEADLINE_MS,
    LIVE_CONTRIBUTOR_TIMEOUT_MS - GATE_DEADLINE_MARGIN_MS - (started - context.startedAt),
  );
  if (budget < GATE_MIN_BUDGET_MS) return finish("skipped", [], { detail: "No time left this turn" });

  try {
    const answer = await withGateDeadline(
      (signal) =>
        mode === "decision"
          ? decisionRejects(candidates, context, signal)
          : librarianRejects(candidates, context, connectionId, signal),
      budget,
    );
    if (answer === "unavailable")
      return finish("unavailable", [], {
        detail: mode === "decision" ? "No Decision model is set up" : "This Engine has no language model host",
      });
    if (answer === "unreadable") return finish("error", [], { detail: "The Librarian's reply wasn't readable" });
    writeVerdict(key, { at: Date.now(), rejected: answer.rejected, model: answer.model });
    return finish("used", answer.rejected, answer.model ? { model: answer.model } : {});
  } catch (error) {
    if (error instanceof GateTimeout) return finish("timeout");
    const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    getLorebookManagerRuntime().logger.warn("[lorebook-manager] Stage 2 gate (%s) failed: %s", mode, detail);
    return finish("error", [], { detail });
  }
}
