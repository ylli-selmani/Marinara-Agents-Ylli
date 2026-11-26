import { parseEntityRef } from "./entity-ref.js";
import type { LmEntryNode, LmLorebookSummary } from "./schema.js";

// Retrieval settings moved to settings-helpers.ts with the settings hub; these names stay for older imports.
export {
  DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS,
  normalizeBookTokenBudgets,
  normalizeCompendiumRetrievalSettings,
} from "./settings-helpers.js";

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
