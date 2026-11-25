import type { FastifyPluginAsync } from "fastify";
import { formatEntityRef, parseEntityRef } from "../../../../shared/src/features/agents/lorebook-manager/entity-ref.js";
import {
  classifyEntryFamily,
  extractMentionEdges,
} from "../../../../shared/src/features/agents/lorebook-manager/graph-model.js";
import type {
  LmEntityNode,
  LmEntryNode,
  LmGraphEdge,
  LmGraphNode,
  LmGraphPayload,
  LmLorebookSummary,
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
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

function extractCharacterFields(rawData: unknown): { name: string; description: string; aliases: string[] } {
  const top = asRecord(rawData);
  const inner = asRecord(top.data);
  const source = Object.keys(inner).length > 0 ? inner : top;
  const extensions = asRecord(source.extensions ?? top.extensions);
  const name = asString(source.name, asString(top.name, "Unnamed character")).trim() || "Unnamed character";
  const description = asString(source.description, asString(top.description)).trim();
  const aliases = [
    ...asStringArray(source.nameAliases),
    ...asStringArray(top.nameAliases),
    ...asStringArray(extensions.nameAliases),
  ];
  return { name, description, aliases: [...new Set(aliases)] };
}

function extractPersonaFields(rawData: unknown): { name: string; description: string; aliases: string[] } {
  const source = asRecord(rawData);
  const name = asString(source.name, "Unnamed persona").trim() || "Unnamed persona";
  const description = asString(source.description).trim();
  const aliases = asStringArray(source.nameAliases);
  return { name, description, aliases };
}

export async function buildLorebookManagerGraphPayload(): Promise<LmGraphPayload> {
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

    lorebooks.push({
      id: rawBook.id,
      name: bookName,
      description: asString(bookData.description),
      category: bookCategory,
      enabled: bookData.enabled !== false,
      entryCount: entries.length,
    });

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      const id = asString(entry.id).trim();
      if (!id) continue;
      const tag = asString(entry.tag).trim();
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
        family: classifyEntryFamily(tag, bookCategory),
        enabled: entry.enabled !== false,
        constant: entry.constant === true,
        locked: entry.locked === true,
        relationships: parseRelationships(entry.relationships),
      });
    }
  }

  const characterNodes: LmEntityNode[] = rawCharacters.map((row) => {
    const fields = extractCharacterFields(row.data);
    return {
      nodeType: "character",
      ref: formatEntityRef("char", row.id),
      id: row.id,
      name: fields.name,
      description: fields.description,
      aliases: fields.aliases,
      family: "character",
    };
  });

  const personaNodes: LmEntityNode[] = rawPersonas.map((row) => {
    const fields = extractPersonaFields(row.data);
    return {
      nodeType: "persona",
      ref: formatEntityRef("persona", row.id),
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

  const mentionEdges = extractMentionEdges(nodes, explicitEdges);

  return {
    lorebooks,
    nodes,
    explicitEdges,
    mentionEdges,
    danglingRelationshipCount,
  };
}

export const lorebookManagerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/graph", async () => {
    return buildLorebookManagerGraphPayload();
  });
};
