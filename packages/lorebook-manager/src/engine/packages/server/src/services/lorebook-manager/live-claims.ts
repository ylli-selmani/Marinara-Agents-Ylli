import type { LmCompendium } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { CHAT_BINDING_DOC_KIND, LOREBOOK_MANAGER_PACKAGE_ID, listCompendiums } from "./compendiums-store.js";
import { getLorebookManagerRuntime } from "./package-runtime.js";

/**
 * Which Compendium each chat is bound to, held in memory.
 *
 * The Engine asks for lorebook claims synchronously on every prompt scan, so the resolver can't read documents.
 * The cache is filled at activation and refreshed after every Compendium or binding write (the routes await the
 * refresh before they answer, so the next generation already sees the change).
 */
let compendiumByChat = new Map<string, LmCompendium>();
let refreshGeneration = 0;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function refreshLiveClaims(): Promise<void> {
  const generation = ++refreshGeneration;
  const documents = getLorebookManagerRuntime().persistence.documents;
  const [compendiums, bindings] = await Promise.all([
    listCompendiums(documents),
    documents.list(LOREBOOK_MANAGER_PACKAGE_ID, CHAT_BINDING_DOC_KIND),
  ]);
  // A refresh that started later read newer data; don't overwrite it with ours.
  if (generation !== refreshGeneration) return;
  const compendiumsById = new Map(compendiums.map((compendium) => [compendium.id, compendium]));
  const next = new Map<string, LmCompendium>();
  for (const binding of bindings) {
    const data = asRecord(binding.data);
    const chatId = typeof data.chatId === "string" ? data.chatId.trim() : "";
    const compendiumId = typeof data.compendiumId === "string" ? data.compendiumId.trim() : "";
    const compendium = compendiumId ? compendiumsById.get(compendiumId) : undefined;
    if (chatId && compendium) next.set(chatId, compendium);
  }
  compendiumByChat = next;
}

/** Refresh after a write. A failed refresh keeps the previous cache and is logged, never thrown at the caller. */
export async function refreshLiveClaimsSafely(): Promise<void> {
  try {
    await refreshLiveClaims();
  } catch (error) {
    try {
      getLorebookManagerRuntime().logger.error(error, "[lorebook-manager] Could not refresh chat bindings");
    } catch {
      // Runtime gone (deactivating); nothing to log to.
    }
  }
}

export function resetLiveClaims(): void {
  refreshGeneration += 1;
  compendiumByChat = new Map();
}

/** The agent id a chat lists in `activeAgentIds` once Lorebook Manager is added to it. */
export const LOREBOOK_MANAGER_AGENT_ID = "lorebook-manager";

/**
 * Is Lorebook Manager added to this chat? The same check as the Engine's Long-Term Memory
 * (`advanced-memory.ts` `longTermMemoryListed`): agents on for the chat, and this agent in its list. A bound
 * Compendium does nothing on its own; without the agent the Engine scans the books as usual.
 */
export function agentAddedToChat(chatMeta: unknown): boolean {
  const meta = asRecord(chatMeta);
  return (
    meta.enableAgents === true &&
    Array.isArray(meta.activeAgentIds) &&
    meta.activeAgentIds.includes(LOREBOOK_MANAGER_AGENT_ID)
  );
}

export function compendiumForChat(chatId: string): LmCompendium | null {
  return compendiumByChat.get(chatId) ?? null;
}

/**
 * The Engine's claim resolver: the bound Compendium's books, which the Engine's own scan then skips. Only while the
 * agent is added to the chat, so removing it hands the books straight back to the Engine.
 */
export function claimLorebooksForChat(request: {
  chatId: string;
  chatMeta?: Record<string, unknown>;
}): string[] | null {
  if (!agentAddedToChat(request.chatMeta)) return null;
  const compendium = compendiumByChat.get(request.chatId);
  return compendium && compendium.lorebookIds.length > 0 ? [...compendium.lorebookIds] : null;
}
