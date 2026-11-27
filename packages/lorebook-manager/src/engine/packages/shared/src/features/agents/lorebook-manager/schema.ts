import type { LmSheetOverrides } from "./sheets.js";

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
  "constant" | "keyword" | "bm25" | "semantic" | "location" | "graph_1hop" | "card_inherited" | "card_sheet";

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
  tier: "constant" | "location" | "card" | "direct" | "graph_1hop";
  injectedContent?: string;
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
  /**
   * Entry refs linked to the chat's current map location (World Maps `lorebookEntryIds`). They join the Location
   * tier right after constants, like the Engine's own `current_location` entries.
   */
  currentLocationEntryRefs?: readonly string[];
  /** The current World Maps location id; entries with a `loc:<id>` relationship to it join the Location tier too. */
  currentLocationId?: string | null;
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
  /** Words to skip on top of the built-in list, for shared-word (BM25) matching only. */
  extraStopwords?: readonly string[];
  /** How far a shared-word hit must stand out to count (default "normal"). */
  bm25Strictness?: LmBm25Strictness;
}

export interface LmRetrievalResult {
  activated: LmRetrievalActivatedItem[];
  suppressed: LmRetrievalSuppressedItem[];
  totalTokens: number;
  tokenBudget: number;
  durationMs: number;
  cardInheritedSeedRefs: string[];
}

/** Recall: what live retrieval and Simulate use. Defaults live in the Settings tab; a Compendium may override any field. */
export interface LmRecallSettings {
  tokenBudget: number;
  /** Live retrieval matches the last this-many messages (1–10). */
  queryMessageCount: number;
  maxOneHop: number;
  maxTextHits: number;
  respectBookBudgets: boolean;
  /** Meaning match: also pick entries whose embeddings are close to the recent messages. Off by default. */
  semanticEnabled: boolean;
  /** Minimum calibrated similarity for a meaning match (0.05–0.95). */
  semanticThreshold: number;
  /**
   * Also match the replies' meaning, separately from the user's messages, and keep the stronger score (the Engine's
   * "Include character context"). On by default here: a scene's places and people are mostly in the replies.
   */
  meaningIncludeReplies: boolean;
  /** Stage 2: how meaning-only picks are checked before they reach the prompt. `instant` = not at all. */
  stage2Gate: LmStage2Gate;
  /** The Librarian's connection. null = the agents' default connection, then the chat's. */
  librarianConnectionId: string | null;
  /** Words to skip on top of the built-in list (lowercase, one word each). */
  extraStopwords: string[];
  /** How far a shared-word hit must stand out from the best one to count. */
  bm25Strictness: LmBm25Strictness;
}

export type LmBm25Strictness = "loose" | "normal" | "strict";

/** A Compendium's resolved retrieval settings: the defaults, its overrides, and its own per-book budgets. */
export interface LmCompendiumRetrievalSettings extends LmRecallSettings {
  bookTokenBudgets: Record<string, number>;
}

/** Off; Suggest = every change waits in Review; Automatic = follows the chat's Review Agent Outputs switch. */
export type LmArchivistMode = "off" | "suggest" | "automatic";

export interface LmArchivistSettings {
  mode: LmArchivistMode;
  /** Runs after every this-many assistant turns (1–50). */
  everyNTurns: number;
  /** Read Behind: AI replies it leaves unread at the chat's end, so a swipe can't write lore (0–5; 0 reads the newest). */
  readBehind: number;
  /** null = the agents' default connection, then the chat's. */
  connectionId: string | null;
  /** The answer's token limit; a thinking model spends part of it reasoning. */
  maxTokens: number;
  /** null = the model's own default (Google asks Gemini 3 to keep 1.0; reasoning models ignore it). */
  temperature: number | null;
}

export type LmCrawlerTrigger = "after_archivist" | "on_demand";

export interface LmCrawlerSettings {
  trigger: LmCrawlerTrigger;
  /** null = the Archivist's connection. */
  connectionId: string | null;
  /** Entries per call when it tidies whole books (5–50). */
  batchSize: number;
  /** The answer's token limit; a thinking model spends part of it reasoning. */
  maxTokens: number;
  /** null = the model's own default. */
  temperature: number | null;
}

/** The package's global settings document (the Settings tab). */
/** The prompts Settings → Prompts can edit. */
export type LmPromptKey = "tidy" | "links" | "archivist" | "librarian";
/** Edited instructions per prompt; a missing key uses the built-in text. */
export type LmPromptOverrides = Partial<Record<LmPromptKey, string>>;

export interface LmSettings {
  recall: LmRecallSettings;
  archivist: LmArchivistSettings;
  crawler: LmCrawlerSettings;
  prompts: LmPromptOverrides;
  sheets: LmSheetOverrides;
  /** 0 until first saved. */
  revision: number;
  updatedAt: string;
}

/** The Archivist fields a Compendium may set for itself; its model stays global. */
export type LmArchivistOverride = Partial<Pick<LmArchivistSettings, "mode" | "everyNTurns">>;

/**
 * What a Compendium sets for itself. A field that is absent follows the default, so changing a default reaches every
 * Compendium that didn't set that field.
 */
export interface LmCompendiumOverrides {
  recall?: Partial<LmRecallSettings>;
  archivist?: LmArchivistOverride;
}

export type LmStage2Gate = "instant" | "decision" | "librarian";

/**
 * How the Stage 2 gate went on one turn. Only `used` and `cached` dropped anything; every other status kept the
 * meaning-only picks as Stage 1 chose them.
 */
export type LmGateRunStatus = "used" | "cached" | "nothing_to_check" | "unavailable" | "timeout" | "error" | "skipped";

export interface LmGateRunInfo {
  mode: Exclude<LmStage2Gate, "instant">;
  status: LmGateRunStatus;
  /** Meaning-only picks the gate looked at, and the ones it turned down. */
  checked: number;
  dropped: Array<{ ref: string; name: string }>;
  /** 1-hop entries that came only through dropped ones and went with them (not counted in `checked`). */
  orphaned?: Array<{ ref: string; name: string }>;
  ms: number;
  model?: string;
  detail?: string;
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
  /** Resolved: the defaults plus this Compendium's overrides and per-book budgets. Read-only. */
  retrievalSettings: LmCompendiumRetrievalSettings;
  /** What this Compendium sets for itself (absent = follows the default). */
  overrides: LmCompendiumOverrides;
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
    injectedContent?: string;
    tokens: number;
    reasons: Array<{ kind: LmRetrievalReasonKind; detail: string }>;
  }>;
  suppressedCount: number;
  /** Absent on runs recorded before the semantic lane. */
  semantic?: LmSemanticRunInfo;
  /** Where the chat was this turn, when known. Absent on older runs and when no location source answered. */
  location?: LmLocationRunInfo;
  /** The Stage 2 gate, when the Compendium has one. Absent on Instant. */
  gate?: LmGateRunInfo;
  /** The contributor's whole time (Stage 1 in `durationMs` is only part of it). Absent on older runs. */
  totalMs?: number;
  /** A swipe (or the send after a Peek) of an unchanged moment: the earlier run's lore, nothing ran again. */
  reused?: boolean;
}

/** The location a live run used: World Maps (linked entries + boost) or the World State tracker (boost only). */
export interface LmLocationRunInfo {
  source: "world_maps" | "world_state";
  text: string;
  linkedEntryCount: number;
}

export interface LmChatRuns {
  chatId: string;
  chatName: string;
  runs: LmLiveRunRecord[];
}

export type LmProposalStatus = "pending" | "applied" | "dismissed" | "undone";

/** What an Archivist run came to. Only Run now records the quiet ones (off, not due, …). */
export type LmArchivistRunStatus =
  | "done"
  | "failed"
  | "unavailable"
  | "off"
  | "not_bound"
  | "reply_pending"
  | "cooling_down"
  | "nothing_new"
  | "not_due";

/** What a Crawler (Tidy entries) run came to. */
export type LmCrawlerRunStatus = "done" | "failed" | "unavailable" | "nothing_to_do" | "not_found";

export interface LmCrawlerRunRecord {
  at: string;
  compendiumId: string;
  compendiumName: string | null;
  status: LmCrawlerRunStatus;
  /** manual = Tidy entries; after_archivist = an applied Archivist change; redo = Redo last batch. */
  trigger: "manual" | "after_archivist" | "redo";
  /** Entries sent to the model this run. */
  entryCount: number;
  /** Their ids, so Redo last batch can ask again (runs before round 6 have none). */
  entryIds?: string[];
  /** Suggestions made. */
  proposals: number;
  /** Entries still untidied after this run (in the Compendium's books). */
  remaining: number;
  skipped: Array<{ name: string; why: string }>;
  proposalIds: string[];
  model: string | null;
  ms: number;
  detail?: string;
}

export interface LmArchivistRunRecord {
  at: string;
  chatId: string;
  compendiumId: string | null;
  compendiumName: string | null;
  status: LmArchivistRunStatus;
  /** auto = after turns; manual = Run now; backfill = older unread history. */
  trigger: "auto" | "manual" | "backfill";
  /** Messages read this run. */
  messageCount: number;
  /** Entries looked up and shown in full. */
  candidateCount: number;
  /** Suggestions made (an update folded into a pending one counts too). */
  updates: number;
  creates: number;
  /** What the model said that code left out, and why (locked, unknown entry, already known, dismissed before…). */
  skipped: Array<{ name: string; why: string }>;
  proposalIds: string[];
  model: string | null;
  ms: number;
  detail?: string;
}

/** What the Archivist or Auto-tag & Link suggests. */
export interface LmProposalInput {
  /** update_book: one change to several entries of a lorebook (whole words on), listed in the patch. */
  kind: "create_entry" | "update_entry" | "update_book";
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
  /** Values returned by the Engine after applying; Undo refuses to overwrite later edits. */
  after: Record<string, unknown> | null;
  appliedBy: "manual" | "automatic" | null;
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

export interface LmArchivistBackfillJob {
  status: "running" | "done" | "stopped" | "failed";
  startedAt: string;
  windowsDone: number;
  detail?: string;
}

export interface LmArchivistBackfillStatus {
  olderUnread: number;
  windowsEstimated: number;
  job: LmArchivistBackfillJob | null;
}
