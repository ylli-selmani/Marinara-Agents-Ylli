import type { FastifyPluginAsync } from "fastify";
import { formatEntityRef, parseEntityRef } from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
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
import { getLorebookManagerRuntime } from "./package-runtime.js";

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

export async function buildLorebookManagerGraphPayload(
  requestedLorebookIds?: ReadonlySet<string> | null,
): Promise<LmGraphPayload> {
  const runtime = getLorebookManagerRuntime();
  const [rawLorebooks, rawCharacters, rawPersonas] = await Promise.all([
    runtime.resources.listLorebooks(),
    runtime.resources.listCharacters(),
    runtime.resources.listPersonas(),
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
      characterIds: uniqueNonEmpty(bookData.characterId, bookData.characterIds),
      personaIds: uniqueNonEmpty(bookData.personaId, bookData.personaIds),
      loaded,
    });

    if (!loaded) continue;

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      const id = asString(entry.id).trim();
      if (!id) continue;
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
  const characterNodes: LmEntityNode[] = rawCharacters.map((row) => {
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

  const personaNodes: LmEntityNode[] = rawPersonas.map((row) => {
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
      });
    }
  }

  const mentionEdges = extractMentionEdges(nodes, explicitEdges, extraScanTextByRef);

  return {
    lorebooks,
    nodes,
    explicitEdges,
    mentionEdges,
    danglingRelationshipCount,
  };
}

export const lorebookManagerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/graph", async (request) => {
    const query = request.query as { lorebookIds?: unknown } | undefined;
    const requestedIds = parseLorebookIdsQuery(query?.lorebookIds);
    return buildLorebookManagerGraphPayload(requestedIds);
  });
};
