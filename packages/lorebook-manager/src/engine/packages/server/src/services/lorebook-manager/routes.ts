import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  formatEntityRef,
  isImpliedMutualLink,
  parseEntityRef,
} from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  classifyEntryWithFallback,
  extractMentionEdges,
} from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmEntityNode,
  LmEntryNode,
  LmGraphEdge,
  LmGraphNode,
  LmGraphPayload,
  LmLorebookSummary,
  LorebookFilterMode,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  CompendiumStoreError,
  createCompendium,
  deleteCompendium,
  getChatCompendiumBinding,
  listCompendiums,
  setChatCompendiumBinding,
  updateCompendium,
  type CreateCompendiumInput,
  type UpdateCompendiumInput,
} from "./compendiums-store.js";
import { refreshLiveClaimsSafely } from "./live-claims.js";
import { listLiveRuns } from "./live-retrieval.js";
import { applyProposal, dismissProposal, listProposals } from "./proposals-store.js";
import { getLorebookManagerRuntime } from "./package-runtime.js";
import { entryVectorSource, indexLorebooks, semanticScoresFor, type EntryVectorSource } from "./semantic-index.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((s) => s.trim());
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return asStringArray(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return asStringArray(parsed);
    } catch {
      return trimmed
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseFilterMode(value: unknown): LorebookFilterMode {
  return value === "include" || value === "exclude" ? value : "any";
}

function parseSelectiveLogic(value: unknown): "andAny" | "andAll" | "notAny" | "notAll" {
  return value === "andAll" || value === "notAny" || value === "notAll" ? value : "andAny";
}

function uniqueNonEmpty(single: unknown, list: unknown): string[] {
  const result = new Set<string>();
  const one = asString(single).trim();
  if (one) result.add(one);
  for (const item of asStringArray(list)) {
    const trimmed = item.trim();
    if (trimmed) result.add(trimmed);
  }
  return [...result];
}

function parseRelationships(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, rel] of Object.entries(record)) {
    if (key.trim() && typeof rel === "string" && rel.trim()) {
      result[key] = rel.trim();
    }
  }
  return result;
}

function extractCharacterFields(rawData: unknown): {
  name: string;
  description: string;
  aliases: string[];
  scanText: string;
} {
  const top = asRecord(rawData);
  const inner = asRecord(top.data);
  const source = Object.keys(inner).length > 0 ? inner : top;
  const extensions = asRecord(source.extensions ?? top.extensions);
  const name = asString(source.name, asString(top.name, "Unnamed character")).trim() || "Unnamed character";
  const description = asString(source.description, asString(top.description)).trim();
  const aliases = [
    ...parseStringArray(source.nameAliases),
    ...parseStringArray(top.nameAliases),
    ...parseStringArray(extensions.nameAliases),
  ];
  const scanText = [
    description,
    asString(source.personality),
    asString(source.scenario),
    asString(extensions.backstory),
    asString(extensions.appearance),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return { name, description, aliases: [...new Set(aliases)], scanText };
}

function extractPersonaFields(rawData: unknown): {
  name: string;
  description: string;
  aliases: string[];
  scanText: string;
} {
  const source = asRecord(rawData);
  const name = asString(source.name, "Unnamed persona").trim() || "Unnamed persona";
  const description = asString(source.description).trim();
  const aliases = parseStringArray(source.nameAliases);
  const scanText = [description, asString(source.appearance), asString(source.comment)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return { name, description, aliases: [...new Set(aliases)], scanText };
}

function parseLorebookIdsQuery(rawQuery: unknown): ReadonlySet<string> | null {
  if (typeof rawQuery !== "string") return null;
  const trimmed = rawQuery.trim();
  if (!trimmed) return null;
  if (trimmed === "__none__") return new Set();
  const ids = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : new Set();
}

export interface BuildGraphOptions {
  lorebookIds?: ReadonlySet<string> | null;
  characterIds?: ReadonlySet<string> | null;
  personaIds?: ReadonlySet<string> | null;
  /** Live retrieval: fetch only the requested books, cards and personas (an absent or empty set loads none). */
  onlyRequested?: boolean;
  /** Live retrieval doesn't read mention edges, so skip computing them. */
  skipMentions?: boolean;
  /**
   * Meaning match: filled with each loaded entry's embedding text and Engine vector. Kept beside the payload, never
   * in it, because the payload goes to the client.
   */
  vectorSources?: EntryVectorSource[];
}

export async function buildLorebookManagerGraphPayload(
  requestedOrOptions?: ReadonlySet<string> | BuildGraphOptions | null,
): Promise<LmGraphPayload> {
  const options: BuildGraphOptions =
    requestedOrOptions instanceof Set
      ? { lorebookIds: requestedOrOptions }
      : requestedOrOptions && typeof requestedOrOptions === "object"
        ? requestedOrOptions
        : {};
  const requestedLorebookIds = options.lorebookIds ?? null;
  const requestedCharacterIds = options.characterIds ?? null;
  const requestedPersonaIds = options.personaIds ?? null;

  const runtime = getLorebookManagerRuntime();
  const only = options.onlyRequested === true;
  const idsOrNone = (ids: ReadonlySet<string> | null) => (ids && ids.size > 0 ? [...ids] : null);
  const [rawLorebooks, rawCharacters, rawPersonas] = await Promise.all([
    only
      ? idsOrNone(requestedLorebookIds)
        ? runtime.resources.listLorebooks(idsOrNone(requestedLorebookIds)!)
        : Promise.resolve([])
      : runtime.resources.listLorebooks(),
    only
      ? idsOrNone(requestedCharacterIds)
        ? runtime.resources.listCharacters(idsOrNone(requestedCharacterIds)!)
        : Promise.resolve([])
      : runtime.resources.listCharacters(),
    only
      ? idsOrNone(requestedPersonaIds)
        ? runtime.resources.listPersonas(idsOrNone(requestedPersonaIds)!)
        : Promise.resolve([])
      : runtime.resources.listPersonas(),
  ]);

  const lorebooks: LmLorebookSummary[] = [];
  const entryNodes: LmEntryNode[] = [];

  for (const rawBook of rawLorebooks) {
    const bookData = asRecord(rawBook.data);
    const bookName = asString(bookData.name, "Untitled lorebook");
    const bookCategory = asString(bookData.category, "uncategorized");
    const entries = Array.isArray(rawBook.entries) ? rawBook.entries : [];
    const loaded = requestedLorebookIds == null || requestedLorebookIds.has(rawBook.id);

    lorebooks.push({
      id: rawBook.id,
      name: bookName,
      description: asString(bookData.description),
      category: bookCategory,
      enabled: bookData.enabled !== false,
      entryCount: entries.length,
      tokenBudget: typeof bookData.tokenBudget === "number" && bookData.tokenBudget > 0 ? bookData.tokenBudget : null,
      imagePath: asString(bookData.imagePath).trim() || null,
      imageCrop: bookData.imageCrop ?? null,
      characterIds: uniqueNonEmpty(bookData.characterId, bookData.characterIds),
      personaIds: uniqueNonEmpty(bookData.personaId, bookData.personaIds),
      loaded,
      vectorsOff: bookData.excludeFromVectorization === true,
    });

    if (!loaded) continue;

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      const id = asString(entry.id).trim();
      if (!id) continue;
      if (options.vectorSources) {
        const source = entryVectorSource(rawBook.id, bookData, entry);
        if (source) options.vectorSources.push(source);
      }
      const tag = asString(entry.tag).trim();
      const classification = classifyEntryWithFallback(tag, bookCategory);
      entryNodes.push({
        nodeType: "lore",
        ref: formatEntityRef("lore", id),
        id,
        lorebookId: rawBook.id,
        lorebookName: bookName,
        lorebookCategory: bookCategory,
        name: asString(entry.name, "Untitled entry"),
        description: asString(entry.description),
        content: asString(entry.content),
        keys: asStringArray(entry.keys),
        secondaryKeys: asStringArray(entry.secondaryKeys),
        tag,
        family: classification.family,
        secondaryFamilies: classification.secondaryFamilies,
        inferredFamily: classification.inferredFamily,
        enabled: entry.enabled !== false,
        constant: entry.constant === true,
        locked: entry.locked === true,
        selective: entry.selective === true,
        selectiveLogic: parseSelectiveLogic(entry.selectiveLogic),
        useRegex: entry.useRegex === true,
        matchWholeWords: entry.matchWholeWords !== false,
        caseSensitive: entry.caseSensitive === true,
        order: typeof entry.order === "number" ? entry.order : 100,
        characterFilterMode: parseFilterMode(entry.characterFilterMode),
        characterFilterIds: parseStringArray(entry.characterFilterIds),
        relationships: parseRelationships(entry.relationships),
      });
    }
  }

  const extraScanTextByRef = new Map<string, string>();
  const characterNodes: LmEntityNode[] = rawCharacters
    .filter((row) => requestedCharacterIds == null || requestedCharacterIds.has(row.id))
    .map((row) => {
      const fields = extractCharacterFields(row.data);
      const ref = formatEntityRef("char", row.id);
      if (fields.scanText) extraScanTextByRef.set(ref, fields.scanText);
      return {
        nodeType: "character",
        ref,
        id: row.id,
        name: fields.name,
        description: fields.description,
        aliases: fields.aliases,
        family: "character",
      };
    });

  const personaNodes: LmEntityNode[] = rawPersonas
    .filter((row) => requestedPersonaIds == null || requestedPersonaIds.has(row.id))
    .map((row) => {
      const fields = extractPersonaFields(row.data);
      const ref = formatEntityRef("persona", row.id);
      if (fields.scanText) extraScanTextByRef.set(ref, fields.scanText);
      return {
        nodeType: "persona",
        ref,
        id: row.id,
        name: fields.name,
        description: fields.description,
        aliases: fields.aliases,
        family: "character",
      };
    });

  const nodes: LmGraphNode[] = [...entryNodes, ...characterNodes, ...personaNodes];
  const nodeRefs = new Set(nodes.map((node) => node.ref));

  const explicitEdges: LmGraphEdge[] = [];
  let danglingRelationshipCount = 0;

  for (const entry of entryNodes) {
    for (const [rawTarget, relation] of Object.entries(entry.relationships)) {
      const parsed = parseEntityRef(rawTarget);
      if (!parsed || !nodeRefs.has(parsed.ref)) {
        danglingRelationshipCount += 1;
        continue;
      }
      explicitEdges.push({
        kind: "explicit",
        sourceRef: entry.ref,
        targetRef: parsed.ref,
        relation,
        ...(isImpliedMutualLink(parsed.ref, relation) ? { bidirectional: true } : {}),
      });
    }
  }

  const mentionEdges = options.skipMentions ? [] : extractMentionEdges(nodes, explicitEdges, extraScanTextByRef);

  return {
    lorebooks,
    nodes,
    explicitEdges,
    mentionEdges,
    danglingRelationshipCount,
  };
}

function sendRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof CompendiumStoreError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  try {
    getLorebookManagerRuntime().logger.error(error, "[lorebook-manager] Unexpected route error");
  } catch {
    // Runtime not available; nothing to log to.
  }
  return reply.code(500).send({ error: "Unexpected server error" });
}

/** Set by the server entry once claims and the contributor are registered (Capability API 1.839). */
let liveRetrievalRegistered = false;
export function setLiveRetrievalRegistered(value: boolean): void {
  liveRetrievalRegistered = value;
}

export const lorebookManagerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/graph", async (request) => {
    const query = request.query as { lorebookIds?: unknown; characterIds?: unknown; personaIds?: unknown } | undefined;
    return buildLorebookManagerGraphPayload({
      lorebookIds: parseLorebookIdsQuery(query?.lorebookIds),
      characterIds: parseLorebookIdsQuery(query?.characterIds),
      personaIds: parseLorebookIdsQuery(query?.personaIds),
    });
  });

  app.get("/status", async () => {
    const resources = getLorebookManagerRuntime().resources;
    return {
      liveRetrieval: liveRetrievalRegistered && typeof resources.updateLorebookEntry === "function",
    };
  });

  // Meaning match. Index now embeds every missing vector of the given books in this request.
  app.post("/semantic/index", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { lorebookIds?: unknown };
      const lorebookIds = Array.isArray(body.lorebookIds)
        ? body.lorebookIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      if (lorebookIds.length === 0) throw new CompendiumStoreError("Pick at least one lorebook to index", 400);
      return { status: await indexLorebooks(lorebookIds) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Simulate's meaning match: the same similarities a live turn computes, with a longer deadline (not on a turn).
  app.post("/semantic/scores", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { lorebookIds?: unknown; queryText?: unknown };
      const lorebookIds = Array.isArray(body.lorebookIds)
        ? body.lorebookIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      const queryText = typeof body.queryText === "string" ? body.queryText : "";
      const vectorSources: EntryVectorSource[] = [];
      if (lorebookIds.length > 0) {
        await buildLorebookManagerGraphPayload({
          lorebookIds: new Set(lorebookIds),
          onlyRequested: true,
          skipMentions: true,
          vectorSources,
        });
      }
      return await semanticScoresFor(vectorSources, queryText, { timeoutMs: 5000 });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/runs", async (_request, reply) => {
    try {
      return { chats: await listLiveRuns() };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/proposals", async (request, reply) => {
    try {
      const status = (request.query as { status?: unknown } | undefined)?.status;
      const filter = status === "pending" || status === "applied" || status === "dismissed" ? status : undefined;
      return { proposals: await listProposals(getLorebookManagerRuntime().persistence.documents, filter) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/proposals/:id/apply", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return { proposal: await applyProposal(getLorebookManagerRuntime(), id) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/proposals/:id/dismiss", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return { proposal: await dismissProposal(getLorebookManagerRuntime().persistence.documents, id) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/compendiums", async (_request, reply) => {
    try {
      const compendiums = await listCompendiums(getLorebookManagerRuntime().persistence.documents);
      return { compendiums };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/compendiums", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as CreateCompendiumInput;
      const compendium = await createCompendium(getLorebookManagerRuntime().persistence.documents, body);
      await refreshLiveClaimsSafely();
      return reply.code(201).send({ compendium });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/compendiums/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as UpdateCompendiumInput;
      const compendium = await updateCompendium(getLorebookManagerRuntime().persistence.documents, id, body);
      await refreshLiveClaimsSafely();
      return { compendium };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/compendiums/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as { expectedRevision?: unknown } | undefined;
      const revRaw = query?.expectedRevision;
      let expectedRevision: number | undefined;
      if (revRaw !== undefined && !(typeof revRaw === "string" && !revRaw.trim())) {
        expectedRevision = typeof revRaw === "string" ? Number(revRaw) : Number.NaN;
        if (!Number.isInteger(expectedRevision)) {
          throw new CompendiumStoreError("expectedRevision must be an integer", 400);
        }
      }
      await deleteCompendium(getLorebookManagerRuntime().persistence.documents, id, expectedRevision);
      await refreshLiveClaimsSafely();
      return { deleted: true };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/chats/:chatId/binding", async (request, reply) => {
    try {
      const { chatId } = request.params as { chatId: string };
      const binding = await getChatCompendiumBinding(getLorebookManagerRuntime().persistence.documents, chatId);
      return { binding };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/chats/:chatId/binding", async (request, reply) => {
    try {
      const { chatId } = request.params as { chatId: string };
      const body = (request.body ?? {}) as { compendiumId?: string | null; ifCompendiumId?: string | null };
      const binding = await setChatCompendiumBinding(
        getLorebookManagerRuntime().persistence.documents,
        chatId,
        body.compendiumId ?? null,
        typeof body.ifCompendiumId === "string" ? body.ifCompendiumId : null,
      );
      await refreshLiveClaimsSafely();
      return { binding };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
};
