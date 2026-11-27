import type {
  LmArchivistOverride,
  LmArchivistRunRecord,
  LmArchivistSettings,
  LmChatRuns,
  LmCrawlerRunRecord,
  LmCrawlerSettings,
  LmLiveStatus,
  LmProposal,
  LmProposalStatus,
  LmChatCompendiumBinding,
  LmCompendium,
  LmGraphPayload,
  LmRecallSettings,
  LmPromptKey,
  LmSettings,
  LorebookFilterMode,
  LmSemanticIndexStatus,
  LmSemanticRunInfo,
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
  status: ["lorebook-manager", "status"] as const,
  connections: ["lorebook-manager", "connections"] as const,
  settings: ["lorebook-manager", "settings"] as const,
  runs: ["lorebook-manager", "runs"] as const,
  archivistRuns: ["lorebook-manager", "archivist-runs"] as const,
  crawlerRuns: ["lorebook-manager", "crawler-runs"] as const,
  crawlerPending: (compendiumId: string) => ["lorebook-manager", "crawler-pending", compendiumId] as const,
  proposalsRoot: ["lorebook-manager", "proposals"] as const,
  proposals: (status: LmProposalStatus) => ["lorebook-manager", "proposals", status] as const,
  semanticScores: (scopeKey: string, queryText: string) =>
    ["lorebook-manager", "semantic-scores", scopeKey, queryText] as const,
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
  /** The fields this Compendium sets itself, per group (replaces the stored ones; {} = follows every default). */
  overrides: { recall: Partial<LmRecallSettings>; archivist: LmArchivistOverride };
  bookTokenBudgets: Record<string, number>;
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
  ifCompendiumId?: string | null,
): Promise<LmChatCompendiumBinding> {
  const response = await fetch(`${API_ROOT}/chats/${encodeURIComponent(chatId)}/binding`, {
    method: "PUT",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify(ifCompendiumId ? { compendiumId, ifCompendiumId } : { compendiumId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json()) as { binding: LmChatCompendiumBinding };
  return payload.binding;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: "same-origin",
    headers: getAdminSecretHeader(),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as T;
}

export async function fetchLiveStatus(): Promise<LmLiveStatus> {
  return readJson<LmLiveStatus>("/status");
}

export async function fetchSettings(): Promise<LmSettings> {
  const response = await fetch(`${API_ROOT}/settings`, { credentials: "same-origin", headers: getAdminSecretHeader() });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { settings: LmSettings }).settings;
}

export async function saveSettingsApi(input: {
  recall?: Partial<LmRecallSettings>;
  archivist?: Partial<LmArchivistSettings>;
  crawler?: Partial<LmCrawlerSettings>;
  prompts?: Partial<Record<LmPromptKey, string | null>>;
  expectedRevision?: number;
}): Promise<LmSettings> {
  const response = await fetch(`${API_ROOT}/settings`, {
    method: "PUT",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { settings: LmSettings }).settings;
}

export async function resetSettingsApi(expectedRevision?: number): Promise<LmSettings> {
  const response = await fetch(`${API_ROOT}/settings/reset`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ expectedRevision }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { settings: LmSettings }).settings;
}

export async function clearLiveRunsApi(): Promise<number> {
  // No body, so no JSON content type (Fastify refuses an empty JSON body), as in deleteCompendiumApi.
  const response = await fetch(`${API_ROOT}/runs`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, ...getAdminSecretHeader() },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { cleared?: number }).cleared ?? 0;
}

export async function fetchArchivistRuns(): Promise<LmArchivistRunRecord[]> {
  const payload = await readJson<{ runs?: LmArchivistRunRecord[] }>("/archivist/runs");
  return Array.isArray(payload.runs) ? payload.runs : [];
}

/** Run now: read the chat's settled messages at once, whatever the mode and interval. */
export async function runArchivistApi(chatId: string): Promise<{ status: string; run: LmArchivistRunRecord | null }> {
  const response = await fetch(`${API_ROOT}/archivist/run`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ chatId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as { status: string; run: LmArchivistRunRecord | null };
}

export async function fetchCrawlerRuns(): Promise<LmCrawlerRunRecord[]> {
  const payload = await readJson<{ runs?: LmCrawlerRunRecord[] }>("/crawler/runs");
  return Array.isArray(payload.runs) ? payload.runs : [];
}

/** Tidy entries: one Crawler batch over a Compendium's books. */
export async function runCrawlerApi(compendiumId: string): Promise<{ status: string; run: LmCrawlerRunRecord | null }> {
  const response = await fetch(`${API_ROOT}/crawler/run`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ compendiumId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as { status: string; run: LmCrawlerRunRecord | null };
}

/** Redo last batch: dismisses its waiting suggestions and asks the model again about its entries. */
export async function redoCrawlerApi(
  compendiumId: string,
): Promise<{ status: string; run: LmCrawlerRunRecord | null; detail: string | null }> {
  const response = await fetch(`${API_ROOT}/crawler/redo`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ compendiumId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as { status: string; run: LmCrawlerRunRecord | null; detail: string | null };
}

export async function fetchCrawlerPending(compendiumId: string): Promise<number> {
  const payload = await readJson<{ remaining?: number }>(
    `/crawler/pending?compendiumId=${encodeURIComponent(compendiumId)}`,
  );
  return typeof payload.remaining === "number" ? payload.remaining : 0;
}

export async function fetchLiveRuns(): Promise<LmChatRuns[]> {
  const payload = await readJson<{ chats?: LmChatRuns[] }>("/runs");
  return Array.isArray(payload.chats) ? payload.chats : [];
}

/** Vectorize the given books' missing entries for meaning match, and report what is indexed. */
export interface LmConnectionSummary {
  id: string;
  name: string;
  provider: string;
}

/** Providers that can't answer a chat completion (the Librarian's picker leaves them out, like Saucelings'). */
const NON_TEXT_PROVIDERS = new Set(["image_generation", "video_generation", "audio", "decision"]);

/** The user's text connections, for the Librarian's connection picker. */
export async function fetchTextConnections(): Promise<LmConnectionSummary[]> {
  const response = await fetch("/api/connections", { credentials: "same-origin", headers: getAdminSecretHeader() });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const rows = (await response.json()) as LmConnectionSummary[];
  return Array.isArray(rows) ? rows.filter((row) => !NON_TEXT_PROVIDERS.has(row.provider)) : [];
}

export async function indexSemanticApi(lorebookIds: string[]): Promise<LmSemanticIndexStatus> {
  const response = await fetch(`${API_ROOT}/semantic/index`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ lorebookIds }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { status: LmSemanticIndexStatus }).status;
}

/** Simulate's meaning match: each entry's similarity to the query, as a live turn computes it. */
export async function fetchSemanticScores(
  lorebookIds: string[],
  queryText: string,
): Promise<{ scores: Record<string, number>; info: LmSemanticRunInfo }> {
  const response = await fetch(`${API_ROOT}/semantic/scores`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify({ lorebookIds, queryText }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as { scores: Record<string, number>; info: LmSemanticRunInfo };
}

export async function fetchProposals(status: LmProposalStatus): Promise<LmProposal[]> {
  const payload = await readJson<{ proposals?: LmProposal[] }>(`/proposals?status=${status}`);
  return Array.isArray(payload.proposals) ? payload.proposals : [];
}

/** `patch`: the suggestion as trimmed in Review (Apply only); the server takes only less of it. */
export async function decideProposalApi(
  id: string,
  decision: "apply" | "dismiss",
  patch?: Record<string, unknown>,
  /** The revision `patch` was edited on. */
  revision?: number,
): Promise<LmProposal> {
  const response = await fetch(`${API_ROOT}/proposals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
    body: JSON.stringify(decision === "apply" && patch ? { patch, revision } : {}),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return ((await response.json()) as { proposal: LmProposal }).proposal;
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
