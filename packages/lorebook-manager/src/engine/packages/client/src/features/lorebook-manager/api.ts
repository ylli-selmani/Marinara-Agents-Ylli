import type {
  LmGraphPayload,
  LorebookFilterMode,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";

const CSRF_HEADER = "x-marinara-csrf";
const CSRF_HEADER_VALUE = "1";
const ADMIN_SECRET_STORAGE_KEY = "marinara_admin_secret";

export const API_ROOT = "/api/lorebook-manager";

export const lmQueryKeys = {
  root: ["lorebook-manager"] as const,
  graph: (scopeKey: string) => ["lorebook-manager", "graph", scopeKey] as const,
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

function getAdminSecretHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const secret = window.localStorage.getItem(ADMIN_SECRET_STORAGE_KEY)?.trim();
    return secret ? { "X-Admin-Secret": secret } : {};
  } catch {
    return {};
  }
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

export async function fetchLorebookManagerGraph(lorebookIds?: readonly string[] | null): Promise<LmGraphPayload> {
  let query = "";
  if (lorebookIds != null) {
    query =
      lorebookIds.length === 0
        ? "?lorebookIds=__none__"
        : `?lorebookIds=${lorebookIds.map((id) => encodeURIComponent(id)).join(",")}`;
  }
  const response = await fetch(`${API_ROOT}/graph${query}`, {
    credentials: "same-origin",
    headers: getAdminSecretHeader(),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as LmGraphPayload;
}

export async function patchLorebookEntry(lorebookId: string, entryId: string, patch: LmEntryPatch): Promise<void> {
  const response = await fetch(
    `/api/lorebooks/${encodeURIComponent(lorebookId)}/entries/${encodeURIComponent(entryId)}`,
    {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
        ...getAdminSecretHeader(),
      },
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
