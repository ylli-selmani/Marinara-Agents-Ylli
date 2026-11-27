import { randomUUID } from "node:crypto";
import {
  diffRecallSettings,
  migrateLegacyRetrievalSettings,
  normalizeArchivistOverride,
  normalizeBookTokenBudgets,
  normalizeCompendiumOverrides,
  normalizeRecallOverrides,
  normalizeRecallSettings,
  resolveRetrievalSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import type {
  LmArchivistOverride,
  LmChatCompendiumBinding,
  LmCompendium,
  LmCompendiumOverrides,
  LmCompendiumRetrievalSettings,
  LmRecallSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import type { LorebookManagerDocumentRecord, LorebookManagerDocumentStore } from "./package-runtime.js";
import { getSettings } from "./settings-store.js";

export const LOREBOOK_MANAGER_PACKAGE_ID = "lorebook-manager";
export const COMPENDIUM_DOC_KIND = "compendium";
export const CHAT_BINDING_DOC_KIND = "chat_binding";

export class CompendiumStoreError extends Error {
  readonly statusCode: 400 | 404 | 409 | 501;

  constructor(message: string, statusCode: 400 | 404 | 409 | 501) {
    super(message);
    this.name = "CompendiumStoreError";
    this.statusCode = statusCode;
  }
}

export interface CreateCompendiumInput {
  name: string;
  description?: string;
  lorebookIds?: string[];
  characterIds?: string[];
  personaIds?: string[];
  worldMapId?: string | null;
  /** What this Compendium sets for itself; a group left out follows the defaults. */
  overrides?: CompendiumOverridesInput;
  bookTokenBudgets?: Record<string, number>;
  /** Pre-hub input: fields that differ from the defaults become overrides, `bookTokenBudgets` the per-book budgets. */
  retrievalSettings?: Partial<LmCompendiumRetrievalSettings>;
}

/** Each group given replaces the stored one wholesale; null clears it (back to the defaults); left out = unchanged. */
export interface CompendiumOverridesInput {
  recall?: Partial<LmRecallSettings> | null;
  archivist?: LmArchivistOverride | null;
}

export interface UpdateCompendiumInput {
  name?: string;
  description?: string;
  lorebookIds?: string[];
  characterIds?: string[];
  personaIds?: string[];
  worldMapId?: string | null;
  overrides?: CompendiumOverridesInput;
  bookTokenBudgets?: Record<string, number>;
  /**
   * Pre-hub input. Only fields whose value differs from what the Compendium resolves to now become overrides, so a
   * client that sends the whole object on every save doesn't pin every field.
   */
  retrievalSettings?: Partial<LmCompendiumRetrievalSettings>;
  expectedRevision?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * The stored overrides and per-book budgets. A Compendium saved before the settings hub has only `retrievalSettings`;
 * it reads as overrides through the migration (lazily: the new shape is written on its next save).
 */
function storedSettings(data: Record<string, unknown>): {
  overrides: LmCompendiumOverrides;
  bookTokenBudgets: Record<string, number>;
} {
  if (data.overrides === undefined && data.retrievalSettings !== undefined) {
    return migrateLegacyRetrievalSettings(data.retrievalSettings);
  }
  return {
    overrides: normalizeCompendiumOverrides(data.overrides),
    bookTokenBudgets: normalizeBookTokenBudgets(data.bookTokenBudgets),
  };
}

function toCompendium(doc: LorebookManagerDocumentRecord, recallDefaults: Readonly<LmRecallSettings>): LmCompendium {
  const data = asRecord(doc.data);
  const worldMapId = typeof data.worldMapId === "string" && data.worldMapId.trim() ? data.worldMapId.trim() : null;
  const { overrides, bookTokenBudgets } = storedSettings(data);
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    lorebookIds: uniqueStrings(data.lorebookIds),
    characterIds: uniqueStrings(data.characterIds),
    personaIds: uniqueStrings(data.personaIds),
    worldMapId,
    retrievalSettings: resolveRetrievalSettings(recallDefaults, overrides, bookTokenBudgets),
    overrides,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function chatBindingDocId(chatId: string): string {
  return `chat_binding:${chatId}`;
}

export async function listCompendiums(documents: LorebookManagerDocumentStore): Promise<LmCompendium[]> {
  const [docs, settings] = await Promise.all([
    documents.list(LOREBOOK_MANAGER_PACKAGE_ID, COMPENDIUM_DOC_KIND),
    getSettings(documents),
  ]);
  return docs
    .filter((doc) => doc.kind === COMPENDIUM_DOC_KIND)
    .map((doc) => toCompendium(doc, settings.recall))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCompendium(documents: LorebookManagerDocumentStore, id: string): Promise<LmCompendium | null> {
  const cleanId = id.trim();
  if (!cleanId) return null;
  const [doc, settings] = await Promise.all([
    documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, cleanId),
    getSettings(documents),
  ]);
  if (!doc || doc.kind !== COMPENDIUM_DOC_KIND) return null;
  return toCompendium(doc, settings.recall);
}

/** Existence only, without reading the settings (bindings check this on every read). */
async function compendiumExists(documents: LorebookManagerDocumentStore, id: string): Promise<boolean> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  return doc?.kind === COMPENDIUM_DOC_KIND;
}

/**
 * Apply an overrides input to the stored overrides: each group given replaces the stored one (null clears it).
 * Legacy `retrievalSettings` fields then become overrides only where they differ from `resolvedNow`.
 */
function nextOverrides(
  current: LmCompendiumOverrides,
  input: CompendiumOverridesInput | undefined,
  legacy: Partial<LmCompendiumRetrievalSettings> | undefined,
  resolvedNow: Readonly<LmRecallSettings>,
): LmCompendiumOverrides {
  let recall = current.recall;
  let archivist = current.archivist;
  if (input && input.recall !== undefined)
    recall = input.recall === null ? undefined : normalizeRecallOverrides(input.recall);
  if (input && input.archivist !== undefined) {
    archivist = input.archivist === null ? undefined : normalizeArchivistOverride(input.archivist);
  }
  if (legacy) {
    const { bookTokenBudgets: _ignored, ...legacyRecall } = legacy;
    const given = normalizeRecallOverrides(legacyRecall);
    const changed = diffRecallSettings(resolvedNow, normalizeRecallSettings({ ...resolvedNow, ...given }, resolvedNow));
    if (Object.keys(changed).length > 0) recall = { ...recall, ...changed };
  }
  return normalizeCompendiumOverrides({ recall, archivist });
}

export async function createCompendium(
  documents: LorebookManagerDocumentStore,
  input: CreateCompendiumInput,
): Promise<LmCompendium> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CompendiumStoreError("Compendium name is required", 400);

  const now = new Date().toISOString();
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const settings = await getSettings(documents);
  const overrides = nextOverrides({}, input.overrides, input.retrievalSettings, settings.recall);
  const bookTokenBudgets = normalizeBookTokenBudgets(
    input.bookTokenBudgets ?? input.retrievalSettings?.bookTokenBudgets,
  );
  const doc = await documents.create({
    id: `compendium:${randomUUID()}`,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    kind: COMPENDIUM_DOC_KIND,
    name,
    description,
    data: {
      lorebookIds: uniqueStrings(input.lorebookIds),
      characterIds: uniqueStrings(input.characterIds),
      personaIds: uniqueStrings(input.personaIds),
      worldMapId: typeof input.worldMapId === "string" && input.worldMapId.trim() ? input.worldMapId.trim() : null,
      overrides,
      bookTokenBudgets,
    },
    createdAt: now,
    updatedAt: now,
  });
  return toCompendium(doc, settings.recall);
}

export async function updateCompendium(
  documents: LorebookManagerDocumentStore,
  id: string,
  input: UpdateCompendiumInput,
): Promise<LmCompendium> {
  const cleanId = id.trim();
  if (!cleanId) throw new CompendiumStoreError("Compendium id is required", 400);

  const existingDoc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, cleanId);
  if (!existingDoc || existingDoc.kind !== COMPENDIUM_DOC_KIND) {
    throw new CompendiumStoreError("Compendium not found", 404);
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== existingDoc.revision) {
    throw new CompendiumStoreError("Compendium was modified concurrently; refresh and try again", 409);
  }

  const settings = await getSettings(documents);
  const existing = toCompendium(existingDoc, settings.recall);
  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) throw new CompendiumStoreError("Compendium name is required", 400);

  const nextDescription = input.description !== undefined ? input.description.trim() : existing.description;
  const overrides = nextOverrides(
    existing.overrides,
    input.overrides,
    input.retrievalSettings,
    existing.retrievalSettings,
  );
  const givenBudgets = input.bookTokenBudgets ?? input.retrievalSettings?.bookTokenBudgets;
  const bookTokenBudgets =
    givenBudgets !== undefined ? normalizeBookTokenBudgets(givenBudgets) : existing.retrievalSettings.bookTokenBudgets;

  const updated = await documents.update({
    id: cleanId,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: input.expectedRevision ?? existingDoc.revision,
    name: nextName,
    description: nextDescription,
    data: {
      lorebookIds: input.lorebookIds !== undefined ? uniqueStrings(input.lorebookIds) : existing.lorebookIds,
      characterIds: input.characterIds !== undefined ? uniqueStrings(input.characterIds) : existing.characterIds,
      personaIds: input.personaIds !== undefined ? uniqueStrings(input.personaIds) : existing.personaIds,
      worldMapId:
        input.worldMapId !== undefined
          ? typeof input.worldMapId === "string" && input.worldMapId.trim()
            ? input.worldMapId.trim()
            : null
          : (existing.worldMapId ?? null),
      overrides,
      bookTokenBudgets,
    },
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw new CompendiumStoreError("Compendium update conflicted with a newer revision", 409);
  }
  return toCompendium(updated, settings.recall);
}

export async function deleteCompendium(
  documents: LorebookManagerDocumentStore,
  id: string,
  expectedRevision?: number,
): Promise<boolean> {
  const cleanId = id.trim();
  if (!cleanId) throw new CompendiumStoreError("Compendium id is required", 400);

  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, cleanId);
  if (!existing || existing.kind !== COMPENDIUM_DOC_KIND) {
    throw new CompendiumStoreError("Compendium not found", 404);
  }
  const revision = expectedRevision ?? existing.revision;
  if (revision !== existing.revision) {
    throw new CompendiumStoreError("Compendium was modified concurrently; refresh and try again", 409);
  }

  const removed = await documents.remove(LOREBOOK_MANAGER_PACKAGE_ID, cleanId, revision);
  if (!removed) throw new CompendiumStoreError("Could not delete Compendium due to revision conflict", 409);

  // Its Crawler state goes too, or the Graph's "Not tidied" marker would still count what it tidied.
  try {
    const crawlState = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, `crawler_state:${cleanId}`);
    if (crawlState) await documents.remove(LOREBOOK_MANAGER_PACKAGE_ID, crawlState.id, crawlState.revision);
  } catch {
    // Best effort: a leftover state only keeps entries counted as tidied.
  }

  // Clear every chat binding that still points at the deleted Compendium. Best effort per binding:
  // getChatCompendiumBinding also treats a dangling id as unbound, so a lost race here is harmless.
  let bindingDocs: Awaited<ReturnType<typeof documents.list>> = [];
  try {
    bindingDocs = await documents.list(LOREBOOK_MANAGER_PACKAGE_ID, CHAT_BINDING_DOC_KIND);
  } catch {
    // The delete already succeeded; the dangling-id guard covers bindings we couldn't list.
  }
  for (const bindingDoc of bindingDocs) {
    if (bindingDoc.kind !== CHAT_BINDING_DOC_KIND) continue;
    const bindingData = asRecord(bindingDoc.data);
    if (typeof bindingData.compendiumId !== "string" || bindingData.compendiumId.trim() !== cleanId) continue;
    try {
      await documents.update({
        id: bindingDoc.id,
        packageId: LOREBOOK_MANAGER_PACKAGE_ID,
        expectedRevision: bindingDoc.revision,
        name: bindingDoc.name,
        description: "",
        data: { ...bindingData, compendiumId: null },
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Left for getChatCompendiumBinding's dangling-id guard.
    }
  }
  return true;
}

export async function getChatCompendiumBinding(
  documents: LorebookManagerDocumentStore,
  chatId: string,
): Promise<LmChatCompendiumBinding> {
  const cleanChatId = chatId.trim();
  if (!cleanChatId) throw new CompendiumStoreError("Chat id is required", 400);

  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, chatBindingDocId(cleanChatId));
  if (!doc || doc.kind !== CHAT_BINDING_DOC_KIND) {
    return { chatId: cleanChatId, compendiumId: null, revision: 0, updatedAt: "" };
  }
  const data = asRecord(doc.data);
  const compendiumId =
    typeof data.compendiumId === "string" && data.compendiumId.trim() ? data.compendiumId.trim() : null;
  const stillExists = compendiumId ? await compendiumExists(documents, compendiumId) : false;
  return {
    chatId: cleanChatId,
    compendiumId: stillExists ? compendiumId : null,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
  };
}

export async function setChatCompendiumBinding(
  documents: LorebookManagerDocumentStore,
  chatId: string,
  compendiumId: string | null,
  ifCompendiumId?: string | null,
): Promise<LmChatCompendiumBinding> {
  const cleanChatId = chatId.trim();
  if (!cleanChatId) throw new CompendiumStoreError("Chat id is required", 400);

  const cleanCompendiumId = typeof compendiumId === "string" && compendiumId.trim() ? compendiumId.trim() : null;
  if (cleanCompendiumId) {
    if (!(await compendiumExists(documents, cleanCompendiumId)))
      throw new CompendiumStoreError("Selected Compendium was not found", 404);
  }

  const docId = chatBindingDocId(cleanChatId);
  const now = new Date().toISOString();
  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, docId);

  // Conditional clear: only unbind when the chat is still bound to the Compendium the caller saw. Checked on the
  // same read whose revision guards the update below, so a rebind in between surfaces as a 409, not a lost bind.
  const cleanIfId = typeof ifCompendiumId === "string" && ifCompendiumId.trim() ? ifCompendiumId.trim() : null;
  if (cleanIfId && !cleanCompendiumId) {
    const current = asRecord(existing?.data);
    const currentId = typeof current.compendiumId === "string" ? current.compendiumId.trim() : null;
    if (currentId !== cleanIfId) return getChatCompendiumBinding(documents, cleanChatId);
  }

  if (!existing) {
    const created = await documents.create({
      id: docId,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: CHAT_BINDING_DOC_KIND,
      name: `Chat ${cleanChatId} Compendium`,
      description: "",
      data: { chatId: cleanChatId, compendiumId: cleanCompendiumId },
      createdAt: now,
      updatedAt: now,
    });
    return {
      chatId: cleanChatId,
      compendiumId: cleanCompendiumId,
      revision: created.revision,
      updatedAt: created.updatedAt,
    };
  }

  const updated = await documents.update({
    id: docId,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: existing.revision,
    name: existing.name || `Chat ${cleanChatId} Compendium`,
    description: "",
    data: { chatId: cleanChatId, compendiumId: cleanCompendiumId },
    updatedAt: now,
  });
  if (!updated) throw new CompendiumStoreError("Chat binding update conflicted; try again", 409);
  return {
    chatId: cleanChatId,
    compendiumId: cleanCompendiumId,
    revision: updated.revision,
    updatedAt: updated.updatedAt,
  };
}
