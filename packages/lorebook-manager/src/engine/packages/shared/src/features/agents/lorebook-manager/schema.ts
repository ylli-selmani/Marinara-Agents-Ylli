export type EntityFamily =
  "character" | "location" | "faction" | "item" | "creature" | "species" | "ability" | "quest" | "lore";

export type LorebookFilterMode = "any" | "include" | "exclude";

export const ENTITY_FAMILIES: readonly EntityFamily[] = [
  "character",
  "location",
  "faction",
  "item",
  "creature",
  "species",
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
  tokenBudget?: number | null;
  imagePath?: string | null;
  imageCrop?: unknown;
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
  selective?: boolean;
  selectiveLogic?: "andAny" | "andAll" | "notAny" | "notAll";
  useRegex?: boolean;
  matchWholeWords?: boolean;
  caseSensitive?: boolean;
  order?: number;
  characterFilterMode: LorebookFilterMode;
  characterFilterIds: string[];
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

export type LmRetrievalReasonKind = "constant" | "keyword" | "bm25" | "location" | "graph_1hop" | "card_inherited";

export interface LmRetrievalReason {
  kind: LmRetrievalReasonKind;
  detail: string;
  score: number;
  fromRef?: string;
  relation?: string;
  matchedTerms?: string[];
}

export interface LmRetrievalActivatedItem {
  entry: LmEntryNode;
  tokens: number;
  score: number;
  tier: "constant" | "direct" | "graph_1hop";
  reasons: LmRetrievalReason[];
  viaRefs: string[];
}

export type LmRetrievalSuppressedReason = "disabled" | "excluded_by_card" | "not_included_by_card" | "over_budget";

export interface LmRetrievalSuppressedItem {
  entry: LmEntryNode;
  tokens: number;
  reason: LmRetrievalSuppressedReason;
  detail: string;
}

export interface LmRetrievalInput {
  queryText: string;
  activeCharacterIds: string[];
  activePersonaId?: string | null;
  activeLocationText?: string;
  tokenBudget: number;
  maxOneHop: number;
  maxTextHits?: number;
  respectBookBudgets?: boolean;
  bookTokenBudgets?: Record<string, number>;
}

export interface LmRetrievalResult {
  activated: LmRetrievalActivatedItem[];
  suppressed: LmRetrievalSuppressedItem[];
  totalTokens: number;
  tokenBudget: number;
  durationMs: number;
  cardInheritedSeedRefs: string[];
}

export interface LmCompendiumRetrievalSettings {
  tokenBudget: number;
  /** Live retrieval matches the last this-many messages (1–10). */
  queryMessageCount: number;
  maxOneHop: number;
  maxTextHits: number;
  respectBookBudgets: boolean;
  bookTokenBudgets: Record<string, number>;
}

export interface LmCompendium {
  id: string;
  name: string;
  description: string;
  lorebookIds: string[];
  characterIds: string[];
  personaIds: string[];
  worldMapId?: string | null;
  retrievalSettings: LmCompendiumRetrievalSettings;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LmChatCompendiumBinding {
  chatId: string;
  compendiumId: string | null;
  revision: number;
  updatedAt: string;
}
