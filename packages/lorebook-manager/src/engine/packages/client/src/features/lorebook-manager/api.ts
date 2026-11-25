import type {
  LmChatCompendiumBinding,
  LmCompendium,
  LmCompendiumRetrievalSettings,
  LmGraphPayload,
  LorebookFilterMode,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";

const CSRF_HEADER = "x-marinara-csrf";
const CSRF_HEADER_VALUE = "1";
const ADMIN_SECRET_STORAGE_KEY = "marinara_admin_secret";

export const API_ROOT = "/api/lorebook-manager";

export const lmQueryKeys = {
  root: ["lorebook-manager"] as const,
  graphRoot: ["lorebook-manager", "graph"] as const,
  graph: (scopeKey: string) => ["lorebook-manager", "graph", scopeKey] as const,
  compendiums: ["lorebook-manager", "compendiums"] as const,
  chatBinding: (chatId: string) => ["lorebook-manager", "chat-binding", chatId] as const,
};

export interface LmEntryPatch {
  name?: string;
  description?: string;
  content?: string;
  keys?: string[];
  secondaryKeys?: string[];
  tag?: string;
  enabled?: boolean;
  constant?: boolean;
  characterFilterMode?: LorebookFilterMode;
  characterFilterIds?: string[];
  relationships?: Record<string, string>;
}

export interface LmCompendiumSavePayload {
  name: string;
  description: string;
  lorebookIds: string[];
  characterIds: string[];
  personaIds: string[];
  worldMapId?: string | null;
  retrievalSettings: LmCompendiumRetrievalSettings;
  expectedRevision?: number;
}

export interface FetchGraphParams {
  lorebookIds?: readonly string[] | null;
  characterIds?: readonly string[] | null;
  personaIds?: readonly string[] | null;
}

function getAdminSecretHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const secret = window.localStorage.getItem(ADMIN_SECRET_STORAGE_KEY)?.trim();
    return secret ? { "X-Admin-Secret": secret } : {};
  } catch {
    return {};
  }
}

function writeHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
    ...getAdminSecretHeader(),
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    } catch {
      return text;
    }
  }
  return `Request failed (${response.status})`;
}

function appendIdListParam(searchParams: URLSearchParams, key: string, ids: readonly string[] | null | undefined) {
  if (ids == null) return;
  searchParams.set(key, ids.length === 0 ? "__none__" : ids.join(","));
}

export async function fetchLorebookManagerGraph(
  paramsOrIds?: FetchGraphParams | readonly string[] | null,
): Promise<LmGraphPayload> {
  const params: FetchGraphParams =
    Array.isArray(paramsOrIds) || paramsOrIds === null || paramsOrIds === undefined
      ? { lorebookIds: (paramsOrIds as readonly string[] | null | undefined) ?? undefined }
      : (paramsOrIds as FetchGraphParams);
  const searchParams = new URLSearchParams();
  appendIdListParam(searchParams, "lorebookIds", params.lorebookIds);
  appendIdListParam(searchParams, "characterIds", params.characterIds);
  appendIdListParam(searchParams, "personaIds", params.personaIds);
  const qs = searchParams.toString();
  const response = await fetch(`${API_ROOT}/graph${qs ? `?${qs}` : ""}`, {
    credentials: "same-origin",
    headers: getAdminSecretHeader(),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as LmGraphPayload;
}

export async function fetchCompendiums(): Promise<LmCompendium[]> {
  const response = await fetch(`${API_ROOT}/compendiums`, {
    credentials: "same-origin",
    headers: getAdminSecretHeader(),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { compendiums?: LmCompendium[] };
  return Array.isArray(payload.compendiums) ? payload.compendiums : [];
}

export async function createCompendiumApi(input: LmCompendiumSavePayload): Promise<LmCompendium> {
  const response = await fetch(`${API_ROOT}/compendiums`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { compendium: LmCompendium };
  return payload.compendium;
}

export async function updateCompendiumApi(id: string, input: LmCompendiumSavePayload): Promise<LmCompendium> {
  const response = await fetch(`${API_ROOT}/compendiums/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { compendium: LmCompendium };
  return payload.compendium;
}

export async function deleteCompendiumApi(id: string, expectedRevision?: number): Promise<void> {
  const query = expectedRevision !== undefined ? `?expectedRevision=${expectedRevision}` : "";
  const response = await fetch(`${API_ROOT}/compendiums/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: {
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      ...getAdminSecretHeader(),
    },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
}

export async function fetchChatCompendiumBinding(chatId: string): Promise<LmChatCompendiumBinding> {
  const response = await fetch(`${API_ROOT}/chats/${encodeURIComponent(chatId)}/binding`, {
    credentials: "same-origin",
    headers: getAdminSecretHeader(),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { binding: LmChatCompendiumBinding };
  return payload.binding;
}

export async function setChatCompendiumBindingApi(
  chatId: string,
  compendiumId: string | null,
): Promise<LmChatCompendiumBinding> {
  const response = await fetch(`${API_ROOT}/chats/${encodeURIComponent(chatId)}/binding`, {
    method: "PUT",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ compendiumId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { binding: LmChatCompendiumBinding };
  return payload.binding;
}

export async function patchLorebookEntry(lorebookId: string, entryId: string, patch: LmEntryPatch): Promise<void> {
  const response = await fetch(
    `/api/lorebooks/${encodeURIComponent(lorebookId)}/entries/${encodeURIComponent(entryId)}`,
    {
      method: "PATCH",
      credentials: "same-origin",
      headers: writeHeaders(),
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
}

export async function patchEntryRelationships(
  lorebookId: string,
  entryId: string,
  relationships: Record<string, string>,
): Promise<void> {
  await patchLorebookEntry(lorebookId, entryId, { relationships });
}
