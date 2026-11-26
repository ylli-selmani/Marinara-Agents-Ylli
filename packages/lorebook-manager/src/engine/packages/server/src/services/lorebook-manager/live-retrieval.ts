import { simulateLorebookRetrieval } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmChatRuns,
  LmCompendium,
  LmGateRunInfo,
  LmGraphPayload,
  LmLiveRunRecord,
  LmLocationRunInfo,
  LmRetrievalResult,
  LmSemanticRunInfo,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { agentAddedToChat, compendiumForChat } from "./live-claims.js";
import {
  getLorebookManagerRuntime,
  type LorebookManagerGameStateRecord,
  type LorebookManagerMessageRecord,
} from "./package-runtime.js";
import { buildLorebookManagerGraphPayload } from "./routes.js";
import { semanticScoresFor, type EntryVectorSource } from "./semantic-index.js";
import { runStage2Gate, type GateQueryMessage } from "./stage2-gate.js";

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
  /** On a regenerate or swipe, the message being replaced (Capability API 1.839). */
  regenerateMessageId?: string | null;
  /** Where the chat is on its World Maps map this turn (Capability API 1.839). */
  currentLocation?: { locationId: string; path: string; lorebookEntryIds: string[] } | null;
  /** Peek Prompt or a dry run (Capability API 1.839): the same lore, but no Activity record. */
  preview?: boolean;
}

/** The location Stage 1 uses this turn: what the retrieval input needs, plus what the run log shows. */
export interface LiveLocation {
  text: string;
  entryRefs: string[];
  locationId: string | null;
  info: LmLocationRunInfo;
}

/**
 * Where the chat is. World Maps first: the Engine passes its resolved location with the entries the map links to
 * it (a claim hides those from the Engine's scan, so they are ours to inject). Otherwise the World State tracker's
 * location text, from the latest message before a swipe's replaced one, which only boosts matching location entries.
 */
export function resolveLiveLocation(
  request: Pick<LivePromptContextRequest, "currentLocation" | "regenerateMessageId">,
  messages: readonly LorebookManagerMessageRecord[],
  gameStates: readonly LorebookManagerGameStateRecord[],
): LiveLocation | null {
  const map = request.currentLocation;
  if (map && typeof map.locationId === "string" && map.locationId.trim()) {
    const entryRefs = [...new Set((map.lorebookEntryIds ?? []).filter((id) => typeof id === "string" && id))].map(
      (id) => `lore:${id}`,
    );
    const text = typeof map.path === "string" ? map.path.trim() : "";
    return {
      text,
      entryRefs,
      locationId: map.locationId.trim(),
      info: { source: "world_maps", text, linkedEntryCount: entryRefs.length },
    };
  }
  const indexById = new Map(messages.map((message, index) => [message.id, index]));
  const end = request.regenerateMessageId
    ? (indexById.get(request.regenerateMessageId) ?? messages.length)
    : messages.length;
  let best: { index: number; text: string } | null = null;
  for (const state of gameStates) {
    const index = indexById.get(state.messageId);
    const text = typeof state.location === "string" ? state.location.trim() : "";
    if (index === undefined || index >= end || !text) continue;
    if (!best || index > best.index) best = { index, text };
  }
  if (!best) return null;
  return {
    text: best.text,
    entryRefs: [],
    locationId: null,
    info: { source: "world_state", text: best.text, linkedEntryCount: 0 },
  };
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
 * Messages hidden from the AI and system notes are skipped, like the Engine's own scan. On a regenerate or swipe the
 * replaced message and everything after it are left out too, so every swipe matches the same text.
 */
export function recentQueryText(
  messages: readonly LorebookManagerMessageRecord[],
  count: number,
  regenerateMessageId?: string | null,
): string {
  return recentQueryMessages(messages, count, regenerateMessageId)
    .map((message) => message.content)
    .join("\n\n");
}

/** The same messages as {@link recentQueryText}, with their roles (the Stage 2 gate reads them as a scene). */
export function recentQueryMessages(
  messages: readonly LorebookManagerMessageRecord[],
  count: number,
  regenerateMessageId?: string | null,
): GateQueryMessage[] {
  const regenerateIndex = regenerateMessageId
    ? messages.findIndex((message) => message.id === regenerateMessageId)
    : -1;
  const end = regenerateIndex >= 0 ? regenerateIndex : messages.length;
  const picked: GateQueryMessage[] = [];
  for (let index = end - 1; index >= 0 && picked.length < count; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (parseExtra(message.extra).hiddenFromAI === true) continue;
    const text = (message.agentContent ?? message.content ?? "").trim();
    if (text) picked.push({ role: message.role, content: text });
  }
  return picked.reverse();
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

const SEMANTIC_OFF: LmSemanticRunInfo = {
  status: "off",
  embedMs: 0,
  vectorCount: 0,
  engineVectorCount: 0,
  missingCount: 0,
};

export function toLiveRunRecord(
  compendium: LmCompendium,
  result: LmRetrievalResult,
  at: string,
  semantic?: LmSemanticRunInfo,
  location?: LmLocationRunInfo | null,
  gate?: LmGateRunInfo | null,
  totalMs?: number,
): LmLiveRunRecord {
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
      reasons: item.reasons.map((reason) => ({ kind: reason.kind, detail: reason.detail.slice(0, 120) })),
    })),
    suppressedCount: result.suppressed.length,
    ...(semantic ? { semantic } : {}),
    ...(location ? { location } : {}),
    ...(gate ? { gate } : {}),
    ...(totalMs !== undefined ? { totalMs: Math.round(totalMs) } : {}),
  };
}

/** The chats with recorded runs, most recent first, for the Activity tab. */
export async function listLiveRuns(limit = 20): Promise<LmChatRuns[]> {
  const runtime = getLorebookManagerRuntime();
  const docs = await runtime.persistence.documents.list(LOREBOOK_MANAGER_PACKAGE_ID, LIVE_RUN_DOC_KIND);
  const chats = docs
    .map((doc) => {
      const data = (doc.data ?? {}) as { chatId?: unknown; runs?: unknown };
      const runs = Array.isArray(data.runs) ? (data.runs as LmLiveRunRecord[]) : [];
      return typeof data.chatId === "string" && runs.length > 0 ? { chatId: data.chatId, runs } : null;
    })
    .filter((row): row is { chatId: string; runs: LmLiveRunRecord[] } => row !== null)
    .sort((a, b) => (b.runs[0]?.at ?? "").localeCompare(a.runs[0]?.at ?? ""))
    .slice(0, limit);
  const { persistence } = runtime;
  return Promise.all(
    chats.map(async (row) => {
      const chat =
        typeof persistence.getChat === "function" ? await persistence.getChat(row.chatId).catch(() => null) : null;
      return { chatId: row.chatId, chatName: chat?.name?.trim() || "Untitled chat", runs: row.runs };
    }),
  );
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
 * The per-turn contributor. A chat with the agent added and bound to a Compendium gets Stage 1 retrieval over that Compendium's books (which
 * the Engine's scan skips, because the package claims them). Unbound chats get nothing and the Engine scans as before.
 * Throwing is deliberate on real failures: the Engine then re-scans the claimed books itself, so no lore is lost.
 */
export async function contributeLiveLore(request: LivePromptContextRequest): Promise<string | null> {
  if (!agentAddedToChat(request.chatMeta)) return null;
  const startedAt = Date.now();
  const compendium = compendiumForChat(request.chatId);
  if (!compendium || compendium.lorebookIds.length === 0) return null;
  const runtime = getLorebookManagerRuntime();
  const { persistence } = runtime;
  if (typeof persistence.listMessages !== "function") throw new Error("persistence.listMessages is unavailable");

  const needsWorldState = !request.currentLocation && typeof persistence.listGameStates === "function";
  const [messages, chat, gameStates] = await Promise.all([
    persistence.listMessages(request.chatId),
    typeof persistence.getChat === "function" ? persistence.getChat(request.chatId) : Promise.resolve(null),
    needsWorldState
      ? persistence.listGameStates!(request.chatId).catch((error: unknown) => {
          runtime.logger.warn("[lorebook-manager] Could not read World State for chat %s: %s", request.chatId, error);
          return [] as LorebookManagerGameStateRecord[];
        })
      : Promise.resolve([] as LorebookManagerGameStateRecord[]),
  ]);
  const location = resolveLiveLocation(request, messages, gameStates);
  // Every card in the chat counts as active, like the Engine's scan; the generation's targets come first so
  // `{{char}}` names the one who speaks.
  const activeCharacterIds = [...new Set([...(request.targetCharacterIds ?? []), ...(chat?.characterIds ?? [])])];
  const personaId = request.personaId ?? chat?.personaId ?? null;
  const lorebookIds = new Set(compendium.lorebookIds);
  const settings = compendium.retrievalSettings;
  const vectorSources: EntryVectorSource[] | undefined = settings.semanticEnabled ? [] : undefined;
  const payload = await buildLorebookManagerGraphPayload({
    lorebookIds,
    characterIds: new Set([...compendium.characterIds, ...activeCharacterIds]),
    personaIds: new Set(personaId ? [personaId] : []),
    onlyRequested: true,
    skipMentions: true,
    vectorSources,
  });
  const queryMessages = recentQueryMessages(messages, settings.queryMessageCount, request.regenerateMessageId);
  const queryText = queryMessages.map((message) => message.content).join("\n\n");
  // Meaning match never fails the turn: on a timeout or error Stage 1 runs on text alone, and the run says why.
  const semantic = vectorSources ? await semanticScoresFor(vectorSources, queryText) : null;
  const stage1 = simulateLorebookRetrieval(
    payload,
    {
      queryText,
      ...(semantic?.info.status === "used"
        ? { semanticScores: semantic.scores, semanticThreshold: settings.semanticThreshold }
        : {}),
      activeCharacterIds,
      activePersonaId: personaId,
      ...(location
        ? {
            activeLocationText: location.text,
            currentLocationEntryRefs: location.entryRefs,
            currentLocationId: location.locationId,
          }
        : {}),
      tokenBudget: settings.tokenBudget,
      maxOneHop: settings.maxOneHop,
      maxTextHits: settings.maxTextHits,
      respectBookBudgets: settings.respectBookBudgets,
      bookTokenBudgets: settings.bookTokenBudgets,
    },
    lorebookIds,
  );
  // Stage 2 checks only the meaning-only picks, and keeps them whenever it can't answer.
  const gate = await runStage2Gate(settings, stage1, {
    chatId: request.chatId,
    mode: request.mode,
    queryMessages,
    chatConnectionId: chat?.connectionId ?? null,
    startedAt,
  });
  const result = gate.result;

  if (request.preview !== true)
    void recordLiveRun(
      request.chatId,
      toLiveRunRecord(
        compendium,
        result,
        new Date().toISOString(),
        semantic?.info ?? { ...SEMANTIC_OFF },
        location?.info ?? null,
        gate.info,
        Date.now() - startedAt,
      ),
    ).catch((error) =>
      runtime.logger.warn(
        "[lorebook-manager] Could not record the retrieval run for chat %s: %s",
        request.chatId,
        error,
      ),
    );

  return formatLiveLore(result, payload, { activeCharacterIds, personaId, wrapFormat: request.wrapFormat });
}
