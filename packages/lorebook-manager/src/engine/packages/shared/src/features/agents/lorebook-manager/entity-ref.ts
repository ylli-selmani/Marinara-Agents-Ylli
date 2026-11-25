export type EntityRefKind = "lore" | "char" | "persona" | "book" | "npc" | "item" | "itemdef" | "loc";

export interface ParsedEntityRef {
  kind: EntityRefKind;
  id: string;
  ref: string;
}

const KNOWN_KINDS = new Set<EntityRefKind>(["lore", "char", "persona", "book", "npc", "item", "itemdef", "loc"]);

/**
 * Parse a relationship target or entity reference string. Bare non-empty IDs
 * without a known prefix resolve to `lore:<id>` for backward compatibility
 * with existing Engine `LorebookEntry.relationships` maps.
 */
export function parseEntityRef(raw: string): ParsedEntityRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const prefix = trimmed.slice(0, colonIndex) as EntityRefKind;
    const id = trimmed.slice(colonIndex + 1).trim();
    if (KNOWN_KINDS.has(prefix) && id) {
      return { kind: prefix, id, ref: `${prefix}:${id}` };
    }
  }
  return { kind: "lore", id: trimmed, ref: `lore:${trimmed}` };
}

/** Build a canonical typed entity reference string. */
export function formatEntityRef(kind: EntityRefKind, id: string): string {
  const cleanId = id.trim();
  if (!cleanId) throw new Error(`Cannot format empty ${kind} entity ref`);
  return `${kind}:${cleanId}`;
}

/**
 * Map a canonical EntityRef to the key stored in `LorebookEntry.relationships`.
 * Lorebook entries keep bare IDs so Engine's `remapLorebookEntryRelationships`
 * continues to remap links when duplicating a lorebook; non-lore entities keep
 * their full typed prefix.
 */
export function toRelationshipKey(targetRef: string): string {
  const parsed = parseEntityRef(targetRef);
  if (!parsed) throw new Error(`Invalid entity ref: ${targetRef}`);
  return parsed.kind === "lore" ? parsed.id : parsed.ref;
}
