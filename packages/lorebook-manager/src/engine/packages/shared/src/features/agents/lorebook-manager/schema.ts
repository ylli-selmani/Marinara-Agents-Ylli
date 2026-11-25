export type EntityFamily = "character" | "location" | "faction" | "item" | "quest" | "lore";

export const ENTITY_FAMILIES: readonly EntityFamily[] = ["character", "location", "faction", "item", "quest", "lore"];

export interface LmLorebookSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  entryCount: number;
}

export interface LmEntryNode {
  nodeType: "lore";
  ref: string;
  id: string;
  lorebookId: string;
  lorebookName: string;
  lorebookCategory: string;
  name: string;
  description: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  tag: string;
  family: EntityFamily;
  enabled: boolean;
  constant: boolean;
  locked: boolean;
  relationships: Record<string, string>;
}

export interface LmEntityNode {
  nodeType: "character" | "persona";
  ref: string;
  id: string;
  name: string;
  description: string;
  aliases: string[];
  family: "character";
}

export type LmGraphNode = LmEntryNode | LmEntityNode;

export interface LmGraphEdge {
  kind: "explicit" | "mention";
  sourceRef: string;
  targetRef: string;
  relation: string;
  matchedText?: string;
}

export interface LmGraphPayload {
  lorebooks: LmLorebookSummary[];
  nodes: LmGraphNode[];
  explicitEdges: LmGraphEdge[];
  mentionEdges: LmGraphEdge[];
  danglingRelationshipCount: number;
}

export interface LmGraphFilters {
  lorebookIds?: ReadonlySet<string>;
  hiddenFamilies?: ReadonlySet<EntityFamily>;
  showCharacters?: boolean;
  showPersonas?: boolean;
  showExplicit?: boolean;
  showMentions?: boolean;
  search?: string;
}

export interface LmBuiltGraph {
  nodes: Array<LmGraphNode & { degree: number }>;
  edges: LmGraphEdge[];
}
