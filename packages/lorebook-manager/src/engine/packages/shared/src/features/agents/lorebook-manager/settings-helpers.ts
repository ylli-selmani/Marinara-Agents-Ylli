import { normalizeStopwordList } from "./retrieval.js";
import type {
  LmArchivistMode,
  LmArchivistOverride,
  LmArchivistSettings,
  LmBm25Strictness,
  LmCompendiumOverrides,
  LmCompendiumRetrievalSettings,
  LmCrawlerSettings,
  LmCrawlerTrigger,
  LmRecallSettings,
  LmSettings,
  LmStage2Gate,
} from "./schema.js";

/** Factory defaults for Recall. The Settings tab's values start here, and "Reset to defaults" returns here. */
export const DEFAULT_RECALL_SETTINGS: Readonly<LmRecallSettings> = Object.freeze({
  tokenBudget: 2000,
  queryMessageCount: 2,
  maxOneHop: 6,
  maxTextHits: 5,
  respectBookBudgets: true,
  semanticEnabled: false,
  semanticThreshold: 0.15,
  meaningIncludeReplies: true,
  stage2Gate: "instant",
  librarianConnectionId: null,
  extraStopwords: [] as string[],
  bm25Strictness: "normal",
} satisfies LmRecallSettings);

/**
 * The values every Compendium had before the settings hub (2026-11-27). Frozen on purpose: a Compendium saved before
 * then reads its overrides as "what differs from these", and a later change to the factory defaults must not
 * reinterpret it.
 */
const LEGACY_COMPENDIUM_DEFAULTS: Readonly<
  Omit<LmRecallSettings, "extraStopwords" | "bm25Strictness" | "meaningIncludeReplies">
> = Object.freeze({
  tokenBudget: 2000,
  queryMessageCount: 2,
  maxOneHop: 6,
  maxTextHits: 5,
  respectBookBudgets: true,
  semanticEnabled: false,
  semanticThreshold: 0.15,
  stage2Gate: "instant",
  librarianConnectionId: null,
});

export const DEFAULT_ARCHIVIST_SETTINGS: Readonly<LmArchivistSettings> = Object.freeze({
  mode: "off",
  everyNTurns: 5,
  readBehind: 1,
  connectionId: null,
  maxTokens: 4096,
  // The Engine agents' default (DEFAULT_AGENT_TEMPERATURE); blank in Settings still means the model's own.
  temperature: 0.7,
} satisfies LmArchivistSettings);

export const DEFAULT_CRAWLER_SETTINGS: Readonly<LmCrawlerSettings> = Object.freeze({
  trigger: "after_archivist",
  connectionId: null,
  batchSize: 20,
  // Twice the Archivist's: 20 entries' answers plus a thinking model's reasoning cut off at 3,500 (Ylli's round 5).
  maxTokens: 8192,
  temperature: 0.7,
} satisfies LmCrawlerSettings);

/** The defaults a fresh install resolves to, before anything is saved. Kept for the Compendium dialog's first draw. */
export const DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS: Readonly<LmCompendiumRetrievalSettings> = Object.freeze({
  ...DEFAULT_RECALL_SETTINGS,
  bookTokenBudgets: {},
});

export const RECALL_SETTING_KEYS = Object.keys(DEFAULT_RECALL_SETTINGS) as Array<keyof LmRecallSettings>;
export const ARCHIVIST_OVERRIDE_KEYS = ["mode", "everyNTurns"] as const satisfies ReadonlyArray<
  keyof LmArchivistSettings
>;

const STAGE2_GATES: readonly LmStage2Gate[] = ["instant", "decision", "librarian"];
const BM25_STRICTNESS: readonly LmBm25Strictness[] = ["loose", "normal", "strict"];
const ARCHIVIST_MODES: readonly LmArchivistMode[] = ["off", "suggest", "automatic"];
const CRAWLER_TRIGGERS: readonly LmCrawlerTrigger[] = ["after_archivist", "on_demand"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num * 100) / 100));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function connectionIdOr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.trim() || null : fallback;
}

/** Blank or null = the model's own default; otherwise 0–2. */
function temperatureOr(value: unknown, fallback: number | null): number | null {
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  const num = toNumber(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(2, Math.round(num * 100) / 100));
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Every Recall field, each one valid; a missing or broken field takes the fallback's value. */
export function normalizeRecallSettings(
  raw: unknown,
  fallback: Readonly<LmRecallSettings> = DEFAULT_RECALL_SETTINGS,
): LmRecallSettings {
  const record = asRecord(raw);
  return {
    tokenBudget: clampInt(record.tokenBudget, fallback.tokenBudget, 100, 128000),
    queryMessageCount: clampInt(record.queryMessageCount, fallback.queryMessageCount, 1, 10),
    maxOneHop: clampInt(record.maxOneHop, fallback.maxOneHop, 0, 20),
    maxTextHits: clampInt(record.maxTextHits, fallback.maxTextHits, 0, 25),
    respectBookBudgets: boolOr(record.respectBookBudgets, fallback.respectBookBudgets),
    semanticEnabled: boolOr(record.semanticEnabled, fallback.semanticEnabled),
    semanticThreshold: clampFloat(record.semanticThreshold, fallback.semanticThreshold, 0.05, 0.95),
    meaningIncludeReplies: boolOr(record.meaningIncludeReplies, fallback.meaningIncludeReplies),
    stage2Gate: oneOf(record.stage2Gate, STAGE2_GATES, fallback.stage2Gate),
    librarianConnectionId: connectionIdOr(record.librarianConnectionId, fallback.librarianConnectionId),
    extraStopwords: Array.isArray(record.extraStopwords)
      ? normalizeStopwordList(record.extraStopwords)
      : [...fallback.extraStopwords],
    bm25Strictness: oneOf(record.bm25Strictness, BM25_STRICTNESS, fallback.bm25Strictness),
  };
}

export function normalizeArchivistSettings(
  raw: unknown,
  fallback: Readonly<LmArchivistSettings> = DEFAULT_ARCHIVIST_SETTINGS,
): LmArchivistSettings {
  const record = asRecord(raw);
  return {
    mode: oneOf(record.mode, ARCHIVIST_MODES, fallback.mode),
    everyNTurns: clampInt(record.everyNTurns, fallback.everyNTurns, 1, 50),
    readBehind: clampInt(record.readBehind, fallback.readBehind, 0, 5),
    connectionId: connectionIdOr(record.connectionId, fallback.connectionId),
    maxTokens: clampInt(record.maxTokens, fallback.maxTokens, 512, 65536),
    temperature: temperatureOr(record.temperature, fallback.temperature),
  };
}

export function normalizeCrawlerSettings(
  raw: unknown,
  fallback: Readonly<LmCrawlerSettings> = DEFAULT_CRAWLER_SETTINGS,
): LmCrawlerSettings {
  const record = asRecord(raw);
  return {
    trigger: oneOf(record.trigger, CRAWLER_TRIGGERS, fallback.trigger),
    connectionId: connectionIdOr(record.connectionId, fallback.connectionId),
    batchSize: clampInt(record.batchSize, fallback.batchSize, 5, 50),
    maxTokens: clampInt(record.maxTokens, fallback.maxTokens, 512, 65536),
    temperature: temperatureOr(record.temperature, fallback.temperature),
  };
}

export function defaultSettings(): LmSettings {
  return {
    recall: normalizeRecallSettings({}),
    archivist: normalizeArchivistSettings({}),
    crawler: normalizeCrawlerSettings({}),
    revision: 0,
    updatedAt: "",
  };
}

/** Only the keys present in `raw`, each normalized; absent keys stay absent (they follow the default). */
function pickPresent<T extends object>(raw: unknown, keys: readonly (keyof T)[], full: T): Partial<T> {
  const record = asRecord(raw);
  const picked: Partial<T> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key as string] !== undefined) {
      picked[key] = full[key];
    }
  }
  return picked;
}

export function normalizeRecallOverrides(raw: unknown): Partial<LmRecallSettings> {
  return pickPresent(raw, RECALL_SETTING_KEYS, normalizeRecallSettings(raw));
}

export function normalizeArchivistOverride(raw: unknown): LmArchivistOverride {
  return pickPresent<Pick<LmArchivistSettings, "mode" | "everyNTurns">>(
    raw,
    ARCHIVIST_OVERRIDE_KEYS,
    normalizeArchivistSettings(raw),
  );
}

/** A group with nothing in it is dropped, so "no overrides" has one shape. */
export function normalizeCompendiumOverrides(raw: unknown): LmCompendiumOverrides {
  const record = asRecord(raw);
  const recall = normalizeRecallOverrides(record.recall);
  const archivist = normalizeArchivistOverride(record.archivist);
  return {
    ...(Object.keys(recall).length > 0 ? { recall } : {}),
    ...(Object.keys(archivist).length > 0 ? { archivist } : {}),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => item === b[i]);
  return a === b;
}

/** The Recall fields of `next` that differ from `base`. */
export function diffRecallSettings(
  base: Readonly<LmRecallSettings>,
  next: Readonly<LmRecallSettings>,
): Partial<LmRecallSettings> {
  const diff: Partial<LmRecallSettings> = {};
  for (const key of RECALL_SETTING_KEYS) {
    if (!sameValue(base[key], next[key])) (diff as Record<string, unknown>)[key] = next[key];
  }
  return diff;
}

/** The defaults plus a Compendium's overrides and its per-book budgets. */
export function resolveRetrievalSettings(
  recallDefaults: Readonly<LmRecallSettings>,
  overrides: LmCompendiumOverrides,
  bookTokenBudgets: Record<string, number>,
): LmCompendiumRetrievalSettings {
  return {
    ...normalizeRecallSettings({ ...recallDefaults, ...overrides.recall }, recallDefaults),
    bookTokenBudgets: { ...bookTokenBudgets },
  };
}

export function resolveArchivistSettings(
  defaults: Readonly<LmArchivistSettings>,
  overrides: LmCompendiumOverrides,
): LmArchivistSettings {
  return normalizeArchivistSettings({ ...defaults, ...overrides.archivist }, defaults);
}

/**
 * A Compendium saved before the settings hub kept a full `retrievalSettings` object. It reads as overrides = the
 * fields that differ from the frozen pre-hub defaults, so a Compendium that never changed a value follows the new
 * defaults, and one that did keeps its own.
 */
export function migrateLegacyRetrievalSettings(raw: unknown): {
  overrides: LmCompendiumOverrides;
  bookTokenBudgets: Record<string, number>;
} {
  const record = asRecord(raw);
  // Fields added after the hub never were in an old Compendium: they follow the defaults.
  const legacyBase: LmRecallSettings = {
    ...LEGACY_COMPENDIUM_DEFAULTS,
    extraStopwords: [],
    bm25Strictness: "normal",
    meaningIncludeReplies: DEFAULT_RECALL_SETTINGS.meaningIncludeReplies,
  };
  const legacy = normalizeRecallSettings(record, legacyBase);
  const recall = diffRecallSettings(legacyBase, legacy);
  return {
    overrides: Object.keys(recall).length > 0 ? { recall } : {},
    bookTokenBudgets: normalizeBookTokenBudgets(record.bookTokenBudgets),
  };
}

export function normalizeBookTokenBudgets(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [bookId, value] of Object.entries(asRecord(raw))) {
    const cleanId = bookId.trim();
    if (!cleanId) continue;
    const num = toNumber(value);
    if (Number.isFinite(num) && num > 0) result[cleanId] = Math.round(num);
  }
  return result;
}

/** A full retrieval-settings object from anything; kept for callers that predate the hub (normalizes, no overrides). */
export function normalizeCompendiumRetrievalSettings(raw: unknown): LmCompendiumRetrievalSettings {
  return {
    ...normalizeRecallSettings(raw),
    bookTokenBudgets: normalizeBookTokenBudgets(asRecord(raw).bookTokenBudgets),
  };
}
