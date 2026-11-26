import { parseEntityRef } from "./entity-ref.js";
import type { LmCompendiumRetrievalSettings, LmEntryNode, LmLorebookSummary } from "./schema.js";

export const DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS: LmCompendiumRetrievalSettings = {
  tokenBudget: 2000,
  queryMessageCount: 2,
  maxOneHop: 6,
  maxTextHits: 5,
  respectBookBudgets: true,
  bookTokenBudgets: {},
  semanticEnabled: false,
  semanticThreshold: 0.15,
};

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num * 100) / 100));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

export function normalizeBookTokenBudgets(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [bookId, value] of Object.entries(raw as Record<string, unknown>)) {
    const cleanId = bookId.trim();
    if (!cleanId) continue;
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(num) && num > 0) {
      result[cleanId] = Math.round(num);
    }
  }
  return result;
}

export function normalizeCompendiumRetrievalSettings(raw: unknown): LmCompendiumRetrievalSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    tokenBudget: clampInt(record.tokenBudget, DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.tokenBudget, 100, 128000),
    queryMessageCount: clampInt(
      record.queryMessageCount,
      DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.queryMessageCount,
      1,
      10,
    ),
    maxOneHop: clampInt(record.maxOneHop, DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxOneHop, 0, 20),
    maxTextHits: clampInt(record.maxTextHits, DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxTextHits, 0, 25),
    respectBookBudgets: record.respectBookBudgets !== false,
    bookTokenBudgets: normalizeBookTokenBudgets(record.bookTokenBudgets),
    semanticEnabled: record.semanticEnabled === true,
    semanticThreshold: clampFloat(
      record.semanticThreshold,
      DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.semanticThreshold,
      0.05,
      0.95,
    ),
  };
}

/**
 * Collects all Character Card and Persona IDs linked to a chosen set of lorebooks
 * via lorebook owner metadata (`characterIds`/`personaIds`), loaded entry filters
 * (`characterFilterIds`), or explicit `char:` / `persona:` entry relationships.
 */
export function collectLinkedCastForLorebooks(
  lorebooks: readonly LmLorebookSummary[],
  selectedLorebookIds: ReadonlySet<string> | readonly string[],
  entries: readonly LmEntryNode[] = [],
): { characterIds: string[]; personaIds: string[] } {
  const selected = selectedLorebookIds instanceof Set ? selectedLorebookIds : new Set(selectedLorebookIds);
  const characterIds = new Set<string>();
  const personaIds = new Set<string>();

  for (const book of lorebooks) {
    if (!selected.has(book.id)) continue;
    for (const id of book.characterIds) {
      if (id.trim()) characterIds.add(id.trim());
    }
    for (const id of book.personaIds) {
      if (id.trim()) personaIds.add(id.trim());
    }
  }

  for (const entry of entries) {
    if (!selected.has(entry.lorebookId)) continue;
    for (const id of entry.characterFilterIds) {
      if (id.trim()) characterIds.add(id.trim());
    }
    for (const rawTarget of Object.keys(entry.relationships)) {
      const parsed = parseEntityRef(rawTarget);
      if (!parsed) continue;
      if (parsed.kind === "char") characterIds.add(parsed.id);
      else if (parsed.kind === "persona") personaIds.add(parsed.id);
    }
  }

  return {
    characterIds: [...characterIds],
    personaIds: [...personaIds],
  };
}
