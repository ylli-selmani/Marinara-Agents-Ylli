import { randomUUID } from "node:crypto";
import { normalizeCompendiumRetrievalSettings } from "../../../../shared/src/features/agents/lorebook-manager/compendium-helpers.js";
import type {
  LmChatCompendiumBinding,
  LmCompendium,
  LmCompendiumRetrievalSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import type { LorebookManagerDocumentRecord, LorebookManagerDocumentStore } from "./package-runtime.js";

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
  retrievalSettings?: Partial<LmCompendiumRetrievalSettings>;
}

export interface UpdateCompendiumInput {
  name?: string;
  description?: string;
  lorebookIds?: string[];
  characterIds?: string[];
  personaIds?: string[];
  worldMapId?: string | null;
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

function toCompendium(doc: LorebookManagerDocumentRecord): LmCompendium {
  const data = asRecord(doc.data);
  const worldMapId = typeof data.worldMapId === "string" && data.worldMapId.trim() ? data.worldMapId.trim() : null;
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    lorebookIds: uniqueStrings(data.lorebookIds),
    characterIds: uniqueStrings(data.characterIds),
    personaIds: uniqueStrings(data.personaIds),
    worldMapId,
    retrievalSettings: normalizeCompendiumRetrievalSettings(data.retrievalSettings),
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function chatBindingDocId(chatId: string): string {
  return `chat_binding:${chatId}`;
}

export async function listCompendiums(documents: LorebookManagerDocumentStore): Promise<LmCompendium[]> {
  const docs = await documents.list(LOREBOOK_MANAGER_PACKAGE_ID, COMPENDIUM_DOC_KIND);
  return docs
    .filter((doc) => doc.kind === COMPENDIUM_DOC_KIND)
    .map(toCompendium)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCompendium(documents: LorebookManagerDocumentStore, id: string): Promise<LmCompendium | null> {
  const cleanId = id.trim();
  if (!cleanId) return null;
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, cleanId);
  if (!doc || doc.kind !== COMPENDIUM_DOC_KIND) return null;
  return toCompendium(doc);
}

export async function createCompendium(
  documents: LorebookManagerDocumentStore,
  input: CreateCompendiumInput,
): Promise<LmCompendium> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CompendiumStoreError("Compendium name is required", 400);

  const now = new Date().toISOString();
  const description = typeof input.description === "string" ? input.description.trim() : "";
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
      retrievalSettings: normalizeCompendiumRetrievalSettings(input.retrievalSettings),
    },
    createdAt: now,
    updatedAt: now,
  });
  return toCompendium(doc);
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

  const existing = toCompendium(existingDoc);
  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) throw new CompendiumStoreError("Compendium name is required", 400);

  const nextDescription = input.description !== undefined ? input.description.trim() : existing.description;
  const nextSettings =
    input.retrievalSettings !== undefined
      ? normalizeCompendiumRetrievalSettings({
          ...existing.retrievalSettings,
          ...input.retrievalSettings,
          bookTokenBudgets:
            input.retrievalSettings.bookTokenBudgets !== undefined
              ? input.retrievalSettings.bookTokenBudgets
              : existing.retrievalSettings.bookTokenBudgets,
        })
      : existing.retrievalSettings;

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
      retrievalSettings: nextSettings,
    },
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw new CompendiumStoreError("Compendium update conflicted with a newer revision", 409);
  }
  return toCompendium(updated);
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
  const stillExists = compendiumId ? (await getCompendium(documents, compendiumId)) !== null : false;
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
    const target = await getCompendium(documents, cleanCompendiumId);
    if (!target) throw new CompendiumStoreError("Selected Compendium was not found", 404);
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
