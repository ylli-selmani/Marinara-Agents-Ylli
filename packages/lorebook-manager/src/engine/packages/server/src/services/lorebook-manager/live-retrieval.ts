import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmCompendium,
  LmGraphPayload,
  LmRetrievalResult,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { compendiumForChat } from "./live-claims.js";
import { getLorebookManagerRuntime, type LorebookManagerMessageRecord } from "./package-runtime.js";
import { buildLorebookManagerGraphPayload } from "./routes.js";

export const LIVE_RUN_DOC_KIND = "live_run";
const MAX_RECORDED_RUNS = 20;

/** What the Engine passes a prompt-context contributor (Capability API 1.839). */
export interface LivePromptContextRequest {
  chatId: string;
  chatMeta: Record<string, unknown>;
  mode: string;
  targetCharacterIds?: string[];
  personaId?: string | null;
  wrapFormat?: "xml" | "markdown" | "none";
}

export interface LmLiveRunRecord {
  at: string;
  compendiumId: string;
  compendiumName: string;
  queryMessageCount: number;
  durationMs: number;
  totalTokens: number;
  tokenBudget: number;
  activated: Array<{
    ref: string;
    name: string;
    lorebookName: string;
    tier: string;
    tokens: number;
    reasons: string[];
  }>;
  suppressedCount: number;
}

function parseExtra(extra: unknown): Record<string, unknown> {
  if (extra && typeof extra === "object" && !Array.isArray(extra)) return extra as Record<string, unknown>;
  if (typeof extra !== "string" || !extra.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(extra);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The text Stage 1 matches against: the last `count` user/assistant messages the model can see, oldest first.
 * Messages hidden from the AI and system notes are skipped, like the Engine's own scan.
 */
export function recentQueryText(messages: readonly LorebookManagerMessageRecord[], count: number): string {
  const picked: string[] = [];
  for (let index = messages.length - 1; index >= 0 && picked.length < count; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (parseExtra(message.extra).hiddenFromAI === true) continue;
    const text = (message.agentContent ?? message.content ?? "").trim();
    if (text) picked.push(text);
  }
  return picked.reverse().join("\n\n");
}

function wrapLore(text: string, wrapFormat: LivePromptContextRequest["wrapFormat"]): string {
  if (wrapFormat === "markdown") return `## World info\n\n${text}`;
  if (wrapFormat === "none") return text;
  return `<world_info>\n${text}\n</world_info>`;
}

/** Fill `{{user}}` and `{{char}}` the way an entry author expects; the Engine doesn't resolve macros in package text. */
function fillNameMacros(text: string, names: { user: string | null; char: string | null }): string {
  return text.replace(/\{\{\s*(user|char)\s*\}\}/giu, (match, macro: string) => {
    const value = macro.toLowerCase() === "user" ? names.user : names.char;
    return value ?? match;
  });
}

/** The lore block for one run: activated entries in retrieval order (constants, direct hits, then 1-hop). */
export function formatLiveLore(
  result: LmRetrievalResult,
  payload: LmGraphPayload,
  options: {
    activeCharacterIds: readonly string[];
    personaId?: string | null;
    wrapFormat?: LivePromptContextRequest["wrapFormat"];
  },
): string | null {
  const parts = result.activated.map((item) => item.entry.content.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const nameOf = (nodeType: "character" | "persona", id: string | null | undefined) =>
    id ? (payload.nodes.find((node) => node.nodeType === nodeType && node.id === id)?.name ?? null) : null;
  const names = {
    user: nameOf("persona", options.personaId),
    char: nameOf("character", options.activeCharacterIds[0]),
  };
  return wrapLore(fillNameMacros(parts.join("\n\n"), names), options.wrapFormat);
}

export function toLiveRunRecord(compendium: LmCompendium, result: LmRetrievalResult, at: string): LmLiveRunRecord {
  return {
    at,
    compendiumId: compendium.id,
    compendiumName: compendium.name,
    queryMessageCount: compendium.retrievalSettings.queryMessageCount,
    durationMs: Math.round(result.durationMs * 10) / 10,
    totalTokens: result.totalTokens,
    tokenBudget: result.tokenBudget,
    activated: result.activated.map((item) => ({
      ref: item.entry.ref,
      name: item.entry.name,
      lorebookName: item.entry.lorebookName,
      tier: item.tier,
      tokens: item.tokens,
      reasons: [...new Set(item.reasons.map((reason) => reason.kind))],
    })),
    suppressedCount: result.suppressed.length,
  };
}

function liveRunDocId(chatId: string): string {
  return `live_run:${chatId}`;
}

/** Keep the chat's last runs for the Activity tab. Best effort: a lost write costs one log line, never the turn. */
async function recordLiveRun(chatId: string, record: LmLiveRunRecord): Promise<void> {
  const documents = getLorebookManagerRuntime().persistence.documents;
  const id = liveRunDocId(chatId);
  const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  const previous = Array.isArray((existing?.data as { runs?: unknown } | undefined)?.runs)
    ? ((existing!.data as { runs: LmLiveRunRecord[] }).runs ?? [])
    : [];
  const runs = [record, ...previous].slice(0, MAX_RECORDED_RUNS);
  if (!existing) {
    await documents.create({
      id,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      kind: LIVE_RUN_DOC_KIND,
      name: `Chat ${chatId} retrieval runs`,
      description: "",
      data: { chatId, runs },
      createdAt: record.at,
      updatedAt: record.at,
    });
    return;
  }
  await documents.update({
    id,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: existing.revision,
    name: existing.name,
    description: "",
    data: { chatId, runs },
    updatedAt: record.at,
  });
}

/**
 * The per-turn contributor. A chat bound to a Compendium gets Stage 1 retrieval over that Compendium's books (which
 * the Engine's scan skips, because the package claims them). Unbound chats get nothing and the Engine scans as before.
 * Throwing is deliberate on real failures: the Engine then re-scans the claimed books itself, so no lore is lost.
 */
export async function contributeLiveLore(request: LivePromptContextRequest): Promise<string | null> {
  const compendium = compendiumForChat(request.chatId);
  if (!compendium || compendium.lorebookIds.length === 0) return null;
  const runtime = getLorebookManagerRuntime();
  const { listMessages, getChat } = runtime.resources;
  if (typeof listMessages !== "function") throw new Error("resources.listMessages is unavailable");

  const [messages, chat] = await Promise.all([
    listMessages(request.chatId),
    typeof getChat === "function" ? getChat(request.chatId) : Promise.resolve(null),
  ]);
  // Every card in the chat counts as active, like the Engine's scan; the generation's targets come first so
  // `{{char}}` names the one who speaks.
  const activeCharacterIds = [...new Set([...(request.targetCharacterIds ?? []), ...(chat?.characterIds ?? [])])];
  const personaId = request.personaId ?? chat?.personaId ?? null;
  const lorebookIds = new Set(compendium.lorebookIds);
  const payload = await buildLorebookManagerGraphPayload({
    lorebookIds,
    characterIds: new Set([...compendium.characterIds, ...activeCharacterIds]),
    personaIds: new Set(personaId ? [personaId] : []),
    onlyRequested: true,
    skipMentions: true,
  });
  const settings = compendium.retrievalSettings;
  const result = simulateLorebookRetrieval(
    payload,
    {
      queryText: recentQueryText(messages, settings.queryMessageCount),
      activeCharacterIds,
      activePersonaId: personaId,
      tokenBudget: settings.tokenBudget,
      maxOneHop: settings.maxOneHop,
      maxTextHits: settings.maxTextHits,
      respectBookBudgets: settings.respectBookBudgets,
      bookTokenBudgets: settings.bookTokenBudgets,
    },
    lorebookIds,
  );

  void recordLiveRun(request.chatId, toLiveRunRecord(compendium, result, new Date().toISOString())).catch((error) =>
    runtime.logger.warn("[lorebook-manager] Could not record the retrieval run for chat %s: %s", request.chatId, error),
  );

  return formatLiveLore(result, payload, { activeCharacterIds, personaId, wrapFormat: request.wrapFormat });
}
