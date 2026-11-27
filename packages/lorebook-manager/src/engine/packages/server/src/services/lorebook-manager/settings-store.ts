import {
  defaultSettings,
  normalizeArchivistSettings,
  normalizeCrawlerSettings,
  normalizeRecallSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import { normalizePromptOverrides } from "../../../../shared/src/features/agents/lorebook-manager/prompts.js";
import type {
  LmArchivistSettings,
  LmCrawlerSettings,
  LmPromptOverrides,
  LmRecallSettings,
  LmSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { CompendiumStoreError, LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import type { LorebookManagerDocumentRecord, LorebookManagerDocumentStore } from "./package-runtime.js";

export const SETTINGS_DOC_KIND = "settings";
const SETTINGS_DOC_ID = "settings:global";

export interface SaveSettingsInput {
  recall?: Partial<LmRecallSettings>;
  archivist?: Partial<LmArchivistSettings>;
  crawler?: Partial<LmCrawlerSettings>;
  /** Edited prompts; a key set to "" (or the built-in text) goes back to the built-in one, a missing key stays. */
  prompts?: Partial<Record<keyof LmPromptOverrides, string | null>>;
  /** The revision the caller saw (0 = never saved). A newer one answers 409. */
  expectedRevision?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSettings(doc: LorebookManagerDocumentRecord | null): LmSettings {
  if (!doc || doc.kind !== SETTINGS_DOC_KIND) return defaultSettings();
  const data = asRecord(doc.data);
  return {
    recall: normalizeRecallSettings(data.recall),
    archivist: normalizeArchivistSettings(data.archivist),
    crawler: normalizeCrawlerSettings(data.crawler),
    prompts: normalizePromptOverrides(data.prompts),
    revision: doc.revision,
    updatedAt: doc.updatedAt,
  };
}

/** The global settings; the factory defaults until something is saved. */
export async function getSettings(documents: LorebookManagerDocumentStore): Promise<LmSettings> {
  return toSettings(await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, SETTINGS_DOC_ID));
}

async function writeSettings(
  documents: LorebookManagerDocumentStore,
  next: Pick<LmSettings, "recall" | "archivist" | "crawler" | "prompts">,
  expectedRevision: number | undefined,
): Promise<LmSettings> {
  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, SETTINGS_DOC_ID);
  const currentRevision = existing?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new CompendiumStoreError("Settings were changed elsewhere; reload them and try again", 409);
  }
  const now = new Date().toISOString();
  const data = { recall: next.recall, archivist: next.archivist, crawler: next.crawler, prompts: next.prompts };
  if (!existing) {
    const created = await documents.create({
      id: SETTINGS_DOC_ID,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: SETTINGS_DOC_KIND,
      name: "Lorebook Manager settings",
      description: "",
      data,
      createdAt: now,
      updatedAt: now,
    });
    return toSettings(created);
  }
  const updated = await documents.update({
    id: SETTINGS_DOC_ID,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: existing.revision,
    name: existing.name,
    description: "",
    data,
    updatedAt: now,
  });
  if (!updated) throw new CompendiumStoreError("Settings were changed elsewhere; reload them and try again", 409);
  return toSettings(updated);
}

/** Merge each given group into the saved one; groups left out stay as they are. */
export async function saveSettings(
  documents: LorebookManagerDocumentStore,
  input: SaveSettingsInput,
): Promise<LmSettings> {
  const current = await getSettings(documents);
  return writeSettings(
    documents,
    {
      recall: input.recall
        ? normalizeRecallSettings({ ...current.recall, ...input.recall }, current.recall)
        : current.recall,
      archivist: input.archivist
        ? normalizeArchivistSettings({ ...current.archivist, ...input.archivist }, current.archivist)
        : current.archivist,
      crawler: input.crawler
        ? normalizeCrawlerSettings({ ...current.crawler, ...input.crawler }, current.crawler)
        : current.crawler,
      prompts: input.prompts ? normalizePromptOverrides({ ...current.prompts, ...input.prompts }) : current.prompts,
    },
    input.expectedRevision,
  );
}

/** Back to the factory defaults, edited prompts too. Compendium overrides stay; they are each Compendium's own. */
export async function resetSettings(
  documents: LorebookManagerDocumentStore,
  expectedRevision?: number,
): Promise<LmSettings> {
  const defaults = defaultSettings();
  return writeSettings(documents, defaults, expectedRevision);
}
