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
  /** The book's Vectors switch is off (`excludeFromVectorization`): its entries never match by meaning. */
  vectorsOff?: boolean;
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

export type LmRetrievalReasonKind =
  "constant" | "keyword" | "bm25" | "semantic" | "location" | "graph_1hop" | "card_inherited";

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
  /**
   * Meaning match: calibrated similarity (0–1) of each entry ref to the query, computed by the caller from
   * embeddings. Absent = text matching only, exactly as before the semantic lane.
   */
  semanticScores?: Readonly<Record<string, number>>;
  /** Minimum calibrated similarity for a meaning match (default 0.3, the Engine's own lorebook default). */
  semanticThreshold?: number;
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
  /** Meaning match: also pick entries whose embeddings are close to the recent messages. Off by default. */
  semanticEnabled: boolean;
  /** Minimum calibrated similarity for a meaning match (0.05–0.95). */
  semanticThreshold: number;
}

/** How the meaning-match lane went on one turn. "used" is the only state where similarities reached Stage 1. */
export type LmSemanticRunStatus = "off" | "used" | "no_vectors" | "timeout" | "error";

export interface LmSemanticRunInfo {
  status: LmSemanticRunStatus;
  /** Time spent on the query embedding, in ms. */
  embedMs: number;
  /** Entries with a usable vector, and how many came from the Engine's own lorebook vectors. */
  vectorCount: number;
  engineVectorCount: number;
  /** Entries still waiting for a vector (indexed in the background). */
  missingCount: number;
  detail?: string;
}

/** The meaning-match index of one Compendium, as Index now and the Compendium modal show it. */
export interface LmSemanticIndexStatus {
  spaceLabel: string;
  total: number;
  indexed: number;
  engineVectors: number;
  excluded: number;
  /** Books whose Vectors switch (`excludeFromVectorization`) is off: never matched by meaning, as in the Engine. */
  excludedBooks: string[];
  embedded: number;
  failed: number;
  detail?: string;
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

/** One live retrieval turn, as the Activity tab shows it. */
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
    tier: LmRetrievalActivatedItem["tier"];
    tokens: number;
    reasons: Array<{ kind: LmRetrievalReasonKind; detail: string }>;
  }>;
  suppressedCount: number;
  /** Absent on runs recorded before the semantic lane. */
  semantic?: LmSemanticRunInfo;
}

export interface LmChatRuns {
  chatId: string;
  chatName: string;
  runs: LmLiveRunRecord[];
}

export type LmProposalStatus = "pending" | "applied" | "dismissed";

/** What the Archivist or Auto-tag & Link suggests. */
export interface LmProposalInput {
  kind: "create_entry" | "update_entry";
  lorebookId: string;
  targetEntryId?: string | null;
  entryName: string;
  /** The fields to set (an update) or the new entry's fields (a create). */
  patch: Record<string, unknown>;
  reason?: string;
  source: "archivist" | "crawler";
  chatId?: string | null;
  sourceMessageRefs?: Array<{ messageId: string; swipeIndex: number }>;
  duplicateOfEntryId?: string | null;
}

export interface LmProposal extends Required<Omit<LmProposalInput, "reason">> {
  id: string;
  revision: number;
  status: LmProposalStatus;
  reason: string;
  /** For an applied update: the changed fields' values before, for Undo. */
  before: Record<string, unknown> | null;
  appliedEntryId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface LmLiveStatus {
  /** Capability API 1.839: lorebook claims and the entry write path. */
  liveRetrieval: boolean;
}

export interface LmChatCompendiumBinding {
  chatId: string;
  compendiumId: string | null;
  revision: number;
  updatedAt: string;
}
