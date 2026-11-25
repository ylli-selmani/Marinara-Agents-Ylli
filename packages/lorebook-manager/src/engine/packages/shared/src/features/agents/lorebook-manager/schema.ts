export type EntityFamily = "character" | "location" | "faction" | "item" | "creature" | "ability" | "quest" | "lore";

export const ENTITY_FAMILIES: readonly EntityFamily[] = [
  "character",
  "location",
  "faction",
  "item",
  "creature",
  "ability",
  "quest",
  "lore",
];

export interface LmLorebookSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  entryCount: number;
  characterIds: string[];
  personaIds: string[];
  loaded: boolean;
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
  secondaryFamilies: EntityFamily[];
  inferredFamily: EntityFamily | null;
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

export interface LmBookNode {
  nodeType: "lorebook";
  ref: string;
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  entryCount: number;
  collapsed: boolean;
  family: "lore";
}

export type LmGraphNode = LmEntryNode | LmEntityNode | LmBookNode;

export interface LmGraphEdge {
  kind: "explicit" | "mention" | "book_link";
  sourceRef: string;
  targetRef: string;
  relation: string;
  matchedText?: string;
  bidirectional?: boolean;
  reverseMatchedText?: string;
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
  collapsedLorebookIds?: ReadonlySet<string>;
  hiddenFamilies?: ReadonlySet<EntityFamily>;
  showCharacters?: boolean;
  showPersonas?: boolean;
  showExplicit?: boolean;
  showMentions?: boolean;
  showBookHubs?: boolean;
  hideOrphans?: boolean;
  search?: string;
}

export interface LmBuiltGraph {
  nodes: Array<LmGraphNode & { degree: number }>;
  edges: LmGraphEdge[];
}
