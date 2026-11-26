import { parseEntityRef } from "./entity-ref.js";
import type {
  LmBm25Strictness,
  LmEntryNode,
  LmGraphPayload,
  LmRetrievalActivatedItem,
  LmRetrievalInput,
  LmRetrievalReason,
  LmRetrievalResult,
  LmRetrievalSuppressedItem,
} from "./schema.js";

const STOPWORDS = new Set([
  // Two-letter function words and pronouns (the tokenizer keeps anything of two letters or more).
  "a",
  "am",
  "an",
  "as",
  "at",
  "be",
  "by",
  "do",
  "go",
  "he",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "of",
  "oh",
  "ok",
  "on",
  "or",
  "so",
  "to",
  "up",
  "us",
  "we",
  "ye",
  // Pronouns and short verbs the list below doesn't have.
  "him",
  "its",
  "our",
  "ours",
  "hers",
  "mine",
  "yours",
  "theirs",
  "myself",
  "yourself",
  "himself",
  "herself",
  "itself",
  "ourselves",
  "themselves",
  "isn",
  "aren",
  "wasn",
  "weren",
  "don",
  "doesn",
  "didn",
  "haven",
  "hasn",
  "hadn",
  "won",
  "wouldn",
  "couldn",
  "shouldn",
  "can",
  "cannot",
  "ll",
  "ve",
  "re",
  "let",
  "get",
  "got",
  "gets",
  "says",
  "said",
  "too",
  "yet",
  "now",
  "out",
  "own",
  "same",
  "few",
  "nor",
  "per",
  "via",
  // Chat filler.
  "hey",
  "hi",
  "yeah",
  "yes",
  "yep",
  "nope",
  "okay",
  "um",
  "uh",
  "hmm",
  "ah",
  "huh",
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "are",
  "was",
  "were",
  "but",
  "not",
  "you",
  "your",
  "his",
  "her",
  "she",
  "they",
  "them",
  "their",
  "have",
  "has",
  "had",
  "been",
  "being",
  "does",
  "did",
  "doing",
  "into",
  "onto",
  "about",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "which",
  "why",
  "how",
  "off",
  "over",
  "under",
  "above",
  "below",
  "between",
  "again",
  "then",
  "than",
  "there",
  "here",
  "these",
  "those",
  "while",
  "all",
  "both",
  "each",
  "every",
  "some",
  "any",
  "many",
  "much",
  "more",
  "most",
  "other",
  "another",
  "such",
  "only",
  "just",
  "also",
  "even",
  "still",
  "very",
  "well",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "during",
  "before",
  "after",
  "until",
  "since",
  "through",
  "though",
  "although",
  "because",
  "around",
  "away",
  "down",
  "near",
  "upon",
  "within",
  "without",
  "one",
  "two",
  "first",
  "like",
  "back",
  "way",
  "make",
  "made",
  "take",
  "took",
  "come",
  "came",
  "goes",
  "went",
  "look",
  "looks",
  "watch",
  "watches",
  "step",
  "steps",
]);

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function estimateEntryTokens(entry: Pick<LmEntryNode, "name" | "content">): number {
  return Math.max(1, Math.ceil((entry.name.length + entry.content.length + 4) / 4));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_REGEX_KEY_LENGTH = 300;
const MAX_REGEX_TEXT_LENGTH = 20_000;

function parseRegexLiteral(raw: string): { pattern: string; flags: string } | null {
  if (raw.length < 3 || !raw.startsWith("/")) return null;
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/u);
  return match ? { pattern: match[1]!, flags: match[2] ?? "" } : null;
}

function tokenMatchesText(
  rawToken: string,
  text: string,
  options: { caseSensitive?: boolean; matchWholeWords?: boolean; useRegex?: boolean },
): boolean {
  const token = rawToken.trim();
  if (!token || !text) return false;

  const literal = parseRegexLiteral(token);
  if (literal || options.useRegex) {
    try {
      const pattern = literal ? literal.pattern : token;
      // Cheap ReDoS guard: skip oversized patterns and only scan a bounded prefix of the text.
      if (pattern.length > MAX_REGEX_KEY_LENGTH) return false;
      let flags = literal ? literal.flags : "";
      if (!options.caseSensitive && !flags.includes("i")) flags += "i";
      if (!flags.includes("u")) flags += "u";
      return new RegExp(pattern, flags).test(
        text.length > MAX_REGEX_TEXT_LENGTH ? text.slice(0, MAX_REGEX_TEXT_LENGTH) : text,
      );
    } catch {
      return false;
    }
  }

  if (options.matchWholeWords !== false) {
    const escaped = escapeRegExp(token);
    const prefix = /^[\p{L}\p{N}_]/u.test(token) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = /[\p{L}\p{N}_]$/u.test(token) ? "(?![\\p{L}\\p{N}_])" : "";
    const flags = options.caseSensitive ? "u" : "iu";
    return new RegExp(`${prefix}${escaped}${suffix}`, flags).test(text);
  }

  return options.caseSensitive ? text.includes(token) : text.toLocaleLowerCase().includes(token.toLocaleLowerCase());
}

function findMatchingKey(entry: LmEntryNode, text: string): string | null {
  const opts = {
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useRegex: entry.useRegex,
  };
  const matchedPrimary = entry.keys.find((key) => tokenMatchesText(key, text, opts));
  if (!matchedPrimary) return null;

  if (!entry.selective || entry.secondaryKeys.length === 0) return matchedPrimary;

  const secondaryMatches = entry.secondaryKeys.filter((key) => tokenMatchesText(key, text, opts)).length;
  const logic = entry.selectiveLogic ?? "andAny";
  if (logic === "andAny" && secondaryMatches === 0) return null;
  if (logic === "andAll" && secondaryMatches < entry.secondaryKeys.length) return null;
  if (logic === "notAny" && secondaryMatches > 0) return null;
  if (logic === "notAll" && secondaryMatches >= entry.secondaryKeys.length) return null;

  return matchedPrimary;
}

function tokenizeBm25(text: string, extraStopwords?: ReadonlySet<string>): string[] {
  // Macros like {{user}} are placeholders, not words: a greeting stored with a raw {{user}} matched every entry that
  // says {{user}} on "user" (Ylli's test round 2).
  const tokens =
    text
      .replace(/\{\{[^{}]*\}\}/gu, " ")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token) && !extraStopwords?.has(token));
}

/**
 * Words to skip, split and cleaned the way BM25 reads words (lowercase, letters and digits, two or more), so a
 * saved word always matches what the tokenizer produces.
 */
export function normalizeStopwordList(raw: unknown, limit = 200): string[] {
  const parts = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const token of part.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
      seen.add(token);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

/** The score a shared-word hit needs. A one-word query keeps a low fixed floor; longer ones scale with the best hit. */
export function bm25FloorFor(
  queryTokenCount: number,
  topBm25: number,
  strictness: LmBm25Strictness = "normal",
): number {
  if (strictness === "loose") return queryTokenCount <= 1 ? 1.5 : Math.max(3.0, topBm25 * 0.35);
  if (strictness === "strict") return queryTokenCount <= 1 ? 2.2 : Math.max(5.0, topBm25 * 0.55);
  return queryTokenCount <= 1 ? 1.8 : Math.max(4.0, topBm25 * 0.45);
}

function computeBm25Scores(
  entries: readonly LmEntryNode[],
  queryText: string,
  extraStopwords?: ReadonlySet<string>,
): Map<string, { score: number; matchedTerms: string[] }> {
  const scores = new Map<string, { score: number; matchedTerms: string[] }>();
  // Words to skip only leave the query: the entries' lengths stay as they are, so scores don't shift elsewhere.
  const queryTerms = [...new Set(tokenizeBm25(queryText, extraStopwords))];
  if (queryTerms.length === 0 || entries.length === 0) return scores;

  const docs = entries.map((entry) => {
    const tf = new Map<string, number>();
    let totalWeight = 0;
    const addField = (text: string, weight: number) => {
      for (const tok of tokenizeBm25(text)) {
        tf.set(tok, (tf.get(tok) ?? 0) + weight);
        totalWeight += weight;
      }
    };
    addField(entry.name, 2.5);
    addField(entry.keys.join(" "), 2.0);
    addField(entry.description, 1.5);
    addField(entry.content, 1.0);
    return { ref: entry.ref, tf, length: Math.max(1, totalWeight) };
  });

  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) {
      if ((doc.tf.get(term) ?? 0) > 0) count += 1;
    }
    df.set(term, count);
  }

  const N = docs.length;
  const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.75;

  for (const doc of docs) {
    let total = 0;
    const matched: Array<{ term: string; contrib: number }> = [];
    for (const term of queryTerms) {
      const f = doc.tf.get(term) ?? 0;
      if (f === 0) continue;
      const nq = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - nq + 0.5) / (nq + 0.5));
      const denom = f + k1 * (1 - b + b * (doc.length / avgLen));
      const contrib = idf * ((f * (k1 + 1)) / denom);
      total += contrib;
      matched.push({ term, contrib });
    }
    if (total > 0) {
      matched.sort((aItem, bItem) => bItem.contrib - aItem.contrib);
      scores.set(doc.ref, { score: total, matchedTerms: matched.map((item) => item.term) });
    }
  }
  return scores;
}

function oneHopPolicy(
  relation: string,
  direction: "out" | "in",
  seedMatchedLocation: boolean,
  viaCardInherited: boolean,
): { weight: number; floor: number } {
  const base = relation.trim().toLowerCase();
  if (base === "part_of") return { weight: 1.0, floor: 0 };
  if (base === "located_in") {
    // Outgoing only, like is_a: a place inside Konoha brings Konoha, never Konoha every place in it (Ylli's round 5:
    // the World State naming Konoha pulled the Inuzuka Clan, the Memorial Stone and the Orphanage).
    if (direction === "in") return { weight: 0.85, floor: Number.POSITIVE_INFINITY };
    return { weight: 0.85, floor: seedMatchedLocation || viaCardInherited ? 0 : 0.4 };
  }
  if (base === "is_a" || base === "member_of") {
    // Outgoing only: a child brings its kind (Shiza pulls Dark Fae), a member its group. Never the other way: "Jutsu"
    // pulled every jutsu under it (Ylli's round 4); an instance needs its own match to come in.
    return { weight: 0.75, floor: direction === "out" ? 0 : Number.POSITIVE_INFINITY };
  }
  if (base === "leads") {
    // A leader and their group travel together both ways (mentioning the court brings its queen).
    return { weight: 0.8, floor: 0 };
  }
  if (base === "owns") {
    return { weight: 0.7, floor: viaCardInherited || direction === "out" ? 0 : 0.6 };
  }
  if (base === "ally_of" || base === "rival_of") {
    return { weight: 0.55, floor: viaCardInherited ? 0 : 0.5 };
  }
  return { weight: 0.4, floor: viaCardInherited ? 0 : 0.8 };
}

/**
 * Pure-code Stage 1 retrieval simulation over loaded lorebook entries.
 * Respects enabled state, native active-card filters, `represents` card proxy
 * link inheritance, constant/keyword/regex/location/BM25 matching, relation-weighted
 * gated 1-hop ID graph expansion, and overall + per-lorebook token budgets.
 */
export function simulateLorebookRetrieval(
  payload: LmGraphPayload,
  input: LmRetrievalInput,
  scopedLorebookIds?: ReadonlySet<string>,
): LmRetrievalResult {
  const startedAt = nowMs();
  const queryText = input.queryText ?? "";
  const activeCharSet = new Set(input.activeCharacterIds);
  const locationQuery = (input.activeLocationText ?? "").trim();
  const locationEntryRefs = new Set(input.currentLocationEntryRefs ?? []);
  const currentLocationId = input.currentLocationId?.trim() || null;
  const linkedToCurrentLocation = (entry: LmEntryNode): boolean => {
    if (locationEntryRefs.has(entry.ref)) return true;
    if (!currentLocationId) return false;
    return Object.keys(entry.relationships).some((rawKey) => {
      const parsed = parseEntityRef(rawKey);
      return parsed?.kind === "loc" && parsed.id === currentLocationId;
    });
  };

  const cardNamesById = new Map<string, string>();
  const scopedEntries: LmEntryNode[] = [];
  for (const node of payload.nodes) {
    if (node.nodeType === "character") {
      cardNamesById.set(node.id, node.name);
      continue;
    }
    if (node.nodeType !== "lore") continue;
    if (scopedLorebookIds && scopedLorebookIds.size > 0 && !scopedLorebookIds.has(node.lorebookId)) continue;
    scopedEntries.push(node);
  }

  const bookBudgetsById = new Map<string, number>();
  if (input.respectBookBudgets !== false) {
    for (const book of payload.lorebooks) {
      if (typeof book.tokenBudget === "number" && book.tokenBudget > 0) {
        bookBudgetsById.set(book.id, book.tokenBudget);
      }
    }
  }
  if (input.bookTokenBudgets) {
    for (const [bookId, cap] of Object.entries(input.bookTokenBudgets)) {
      if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
        bookBudgetsById.set(bookId, Math.round(cap));
      }
    }
  }

  const disabledBookIds = new Set(payload.lorebooks.filter((book) => book.enabled === false).map((book) => book.id));

  const entriesByRef = new Map(scopedEntries.map((entry) => [entry.ref, entry]));
  const eligibleEntries: LmEntryNode[] = [];
  const eligibleSet = new Set<string>();
  const suppressed: LmRetrievalSuppressedItem[] = [];

  for (const entry of scopedEntries) {
    const tokens = estimateEntryTokens(entry);
    if (disabledBookIds.has(entry.lorebookId)) {
      suppressed.push({ entry, tokens, reason: "disabled", detail: "Lorebook is disabled" });
      continue;
    }
    if (!entry.enabled) {
      suppressed.push({ entry, tokens, reason: "disabled", detail: "Entry is disabled" });
      continue;
    }
    if (entry.characterFilterMode === "exclude") {
      const hitIds = entry.characterFilterIds.filter((id) => activeCharSet.has(id));
      if (hitIds.length > 0) {
        const names = hitIds.map((id) => cardNamesById.get(id) ?? id).join(", ");
        suppressed.push({
          entry,
          tokens,
          reason: "excluded_by_card",
          detail: `Excluded while ${names} active`,
        });
        continue;
      }
    }
    if (entry.characterFilterMode === "include" && entry.characterFilterIds.length > 0) {
      const hasMatch = entry.characterFilterIds.some((id) => activeCharSet.has(id));
      if (!hasMatch) {
        const names = entry.characterFilterIds.map((id) => cardNamesById.get(id) ?? id).join(", ");
        suppressed.push({
          entry,
          tokens,
          reason: "not_included_by_card",
          detail: `Requires active card: ${names}`,
        });
        continue;
      }
    }
    eligibleEntries.push(entry);
    eligibleSet.add(entry.ref);
  }

  // Active Character Cards inherit explicit 1-hop links from any lorebook entry that `represents` them.
  const cardInheritedSeeds = new Map<string, string>();
  if (activeCharSet.size > 0) {
    for (const entry of scopedEntries) {
      const matchedCards: string[] = [];
      for (const [rawKey, rel] of Object.entries(entry.relationships)) {
        if (rel.trim().toLowerCase() !== "represents") continue;
        const parsed = parseEntityRef(rawKey);
        if (parsed?.kind === "char" && activeCharSet.has(parsed.id)) {
          matchedCards.push(cardNamesById.get(parsed.id) ?? parsed.id);
        }
      }
      if (matchedCards.length > 0) {
        cardInheritedSeeds.set(entry.ref, [...new Set(matchedCards)].join(", "));
      }
    }
  }

  const extraStopwords = input.extraStopwords?.length
    ? new Set(normalizeStopwordList(input.extraStopwords))
    : undefined;
  const bm25Scores = computeBm25Scores(eligibleEntries, queryText, extraStopwords);
  const queryTokenCount = tokenizeBm25(queryText, extraStopwords).length;
  let topBm25 = 0;
  for (const hit of bm25Scores.values()) {
    if (hit.score > topBm25) topBm25 = hit.score;
  }
  const bm25Floor = bm25FloorFor(queryTokenCount, topBm25, input.bm25Strictness);
  const maxTextHits = Math.max(0, input.maxTextHits ?? 5);
  const semanticScores = input.semanticScores ?? null;
  const semanticThreshold = Math.max(0, Math.min(1, input.semanticThreshold ?? 0.3));
  const semanticHit = (ref: string): number | null => {
    const similarity = semanticScores?.[ref];
    return typeof similarity === "number" && Number.isFinite(similarity) && similarity >= semanticThreshold
      ? similarity
      : null;
  };

  const directCandidates = new Map<
    string,
    {
      entry: LmEntryNode;
      tier: "constant" | "location" | "direct";
      score: number;
      reasons: LmRetrievalReason[];
      matchedLocation: boolean;
    }
  >();

  for (const entry of eligibleEntries) {
    const reasons: LmRetrievalReason[] = [];
    let score = 0;
    let tier: "constant" | "location" | "direct" | null = null;
    let matchedLocation = false;

    if (entry.constant) {
      tier = "constant";
      score += 100;
      reasons.push({ kind: "constant", detail: "Constant entry", score: 100 });
    }

    const keywordHit = queryText.trim() ? findMatchingKey(entry, queryText) : null;
    if (keywordHit) {
      tier ??= "direct";
      score += 10;
      reasons.push({ kind: "keyword", detail: `Keyword "${keywordHit}"`, score: 10 });
    }

    // The map links this entry to where the chat is: forced in, like the Engine's `current_location` entries.
    if (linkedToCurrentLocation(entry)) {
      tier ??= "location";
      matchedLocation = true;
      score += 12;
      reasons.push({
        kind: "location",
        detail: locationQuery ? `Linked to the current location "${locationQuery}"` : "Linked to the current location",
        score: 12,
      });
    } else if (
      locationQuery &&
      (entry.family === "location" || entry.secondaryFamilies.includes("location")) &&
      [entry.name, ...entry.keys].some((tok) =>
        tokenMatchesText(tok, locationQuery, { matchWholeWords: true, caseSensitive: false }),
      )
    ) {
      tier ??= "direct";
      matchedLocation = true;
      score += 12;
      reasons.push({ kind: "location", detail: `Location "${locationQuery}"`, score: 12 });
    }

    if (tier) {
      directCandidates.set(entry.ref, { entry, tier, score, reasons, matchedLocation });
    }
  }

  const formatBm25Reason = (bm25Hit: { score: number; matchedTerms: string[] }): LmRetrievalReason => {
    const topTerms = bm25Hit.matchedTerms.slice(0, 3).map((t) => `"${t}"`);
    const extraCount = bm25Hit.matchedTerms.length - topTerms.length;
    const termsLabel = extraCount > 0 ? `${topTerms.join(", ")} +${extraCount}` : topTerms.join(", ");
    return {
      kind: "bm25",
      detail: termsLabel
        ? `Text: ${termsLabel} (${bm25Hit.score.toFixed(1)})`
        : `Text score ${bm25Hit.score.toFixed(1)}`,
      score: bm25Hit.score,
      matchedTerms: bm25Hit.matchedTerms,
    };
  };

  // A meaning match adds at most SEMANTIC_WEIGHT to the score: evidence, but below the 2.2 that seeds 1-hop links,
  // so an entry found by meaning alone never pulls its neighbours in.
  const SEMANTIC_WEIGHT = 2;
  const formatSemanticReason = (similarity: number): LmRetrievalReason => ({
    kind: "semantic",
    detail: `Meaning match ${similarity.toFixed(2)}`,
    score: similarity * SEMANTIC_WEIGHT,
  });

  for (const [ref, direct] of directCandidates) {
    const bm25Hit = bm25Scores.get(ref);
    if (bm25Hit && bm25Hit.score >= 2.0) {
      direct.score += bm25Hit.score;
      direct.reasons.push(formatBm25Reason(bm25Hit));
    }
    const similarity = semanticHit(ref);
    if (similarity !== null) {
      direct.score += similarity * SEMANTIC_WEIGHT;
      direct.reasons.push(formatSemanticReason(similarity));
    }
  }

  if (maxTextHits > 0) {
    const textPool = eligibleEntries.filter((entry) => !directCandidates.has(entry.ref));
    const bm25Ranked = textPool
      .map((entry) => ({ entry, hit: bm25Scores.get(entry.ref) }))
      .filter((item): item is { entry: LmEntryNode; hit: { score: number; matchedTerms: string[] } } =>
        Boolean(item.hit && item.hit.score >= bm25Floor),
      )
      .sort((a, b) => b.hit.score - a.hit.score);
    const semanticRanked = semanticScores
      ? textPool
          .map((entry) => ({ entry, similarity: semanticHit(entry.ref) }))
          .filter((item): item is { entry: LmEntryNode; similarity: number } => item.similarity !== null)
          .sort((a, b) => b.similarity - a.similarity)
      : [];

    // Reciprocal rank fusion only orders the pool; scores stay on the text-score scale the rest of Stage 1 compares.
    // Without semantic scores this is the BM25 order, so the result is the same as text matching alone.
    const RRF_K = 60;
    const fused = new Map<
      string,
      { entry: LmEntryNode; rrf: number; bm25?: { score: number; matchedTerms: string[] }; similarity?: number }
    >();
    bm25Ranked.forEach(({ entry, hit }, index) => {
      fused.set(entry.ref, { entry, rrf: 1 / (RRF_K + index + 1), bm25: hit });
    });
    semanticRanked.forEach(({ entry, similarity }, index) => {
      const existing = fused.get(entry.ref);
      if (existing) {
        existing.rrf += 1 / (RRF_K + index + 1);
        existing.similarity = similarity;
      } else {
        fused.set(entry.ref, { entry, rrf: 1 / (RRF_K + index + 1), similarity });
      }
    });

    // Meaning-only picks get at most half the text slots, so they can't push every text match out.
    const maxMeaningOnly = Math.ceil(maxTextHits / 2);
    let taken = 0;
    let meaningOnlyTaken = 0;
    const ordered = [...fused.values()].sort(
      (a, b) =>
        b.rrf - a.rrf || (b.bm25?.score ?? 0) - (a.bm25?.score ?? 0) || (b.similarity ?? 0) - (a.similarity ?? 0),
    );
    for (const item of ordered) {
      if (taken >= maxTextHits) break;
      if (!item.bm25) {
        if (meaningOnlyTaken >= maxMeaningOnly) continue;
        meaningOnlyTaken += 1;
      }
      taken += 1;
      const reasons: LmRetrievalReason[] = [];
      let score = 0;
      if (item.bm25) {
        score += item.bm25.score;
        reasons.push(formatBm25Reason(item.bm25));
      }
      if (item.similarity !== undefined) {
        score += item.similarity * SEMANTIC_WEIGHT;
        reasons.push(formatSemanticReason(item.similarity));
      }
      directCandidates.set(item.entry.ref, {
        entry: item.entry,
        tier: "direct",
        score,
        reasons,
        matchedLocation: false,
      });
    }
  }

  // Build bidirectional lore adjacency, merging opposing out/in links of the same relation into <->.
  type AdjLink = { neighborRef: string; relation: string; direction: "out" | "in" | "both" };
  const adjacency = new Map<string, AdjLink[]>();
  const adjByPair = new Map<string, AdjLink>();
  const upsertAdj = (fromRef: string, neighborRef: string, relation: string, direction: "out" | "in") => {
    const pairKey = `${fromRef}\u0000${neighborRef}\u0000${relation.trim().toLowerCase()}`;
    const existing = adjByPair.get(pairKey);
    if (existing) {
      if (existing.direction !== direction) existing.direction = "both";
      return;
    }
    const item: AdjLink = { neighborRef, relation, direction };
    adjByPair.set(pairKey, item);
    const list = adjacency.get(fromRef);
    if (list) list.push(item);
    else adjacency.set(fromRef, [item]);
  };

  for (const entry of scopedEntries) {
    for (const [rawKey, rel] of Object.entries(entry.relationships)) {
      if (rel.trim().toLowerCase() === "represents") continue;
      const parsed = parseEntityRef(rawKey);
      if (!parsed || parsed.kind !== "lore") continue;
      const target = entriesByRef.get(parsed.ref);
      if (!target || target.ref === entry.ref) continue;
      upsertAdj(entry.ref, target.ref, rel, "out");
      upsertAdj(target.ref, entry.ref, rel, "in");
    }
  }

  type OneHopCandidate = {
    entry: LmEntryNode;
    score: number;
    reasons: LmRetrievalReason[];
    viaRefs: Set<string>;
  };
  const oneHopByRef = new Map<string, OneHopCandidate>();

  const seedEntries = new Map<string, { viaCardName?: string; seedScore: number; matchedLocation: boolean }>();
  for (const [ref, direct] of directCandidates) {
    if (direct.score >= 2.2) {
      seedEntries.set(ref, {
        viaCardName: cardInheritedSeeds.get(ref),
        seedScore: Math.min(1.5, Math.max(0.75, direct.score / 10)),
        matchedLocation: direct.matchedLocation,
      });
    }
  }
  for (const [ref, cardName] of cardInheritedSeeds) {
    if (!seedEntries.has(ref)) {
      seedEntries.set(ref, { viaCardName: cardName, seedScore: 1.0, matchedLocation: false });
    }
  }

  if (input.maxOneHop > 0) {
    for (const [seedRef, seed] of seedEntries) {
      const seedEntry = entriesByRef.get(seedRef);
      if (!seedEntry) continue;
      for (const link of adjacency.get(seedRef) ?? []) {
        if (!eligibleSet.has(link.neighborRef) || directCandidates.has(link.neighborRef)) continue;
        const neighborEntry = entriesByRef.get(link.neighborRef);
        if (!neighborEntry) continue;

        const effectiveDirection = link.direction === "both" ? "out" : link.direction;
        const policy = oneHopPolicy(link.relation, effectiveDirection, seed.matchedLocation, Boolean(seed.viaCardName));
        const bm25 = bm25Scores.get(link.neighborRef)?.score ?? 0;
        if (bm25 < policy.floor) continue;

        const hopScore = policy.weight * seed.seedScore + bm25 * 0.25;
        // The badge sits on the neighbour, so the arrow reads from it: link "in" (neighbour → seed) shows "→ seed".
        const arrow = link.direction === "both" ? "↔" : link.direction === "in" ? "→" : "←";
        const reason: LmRetrievalReason = seed.viaCardName
          ? {
              kind: "card_inherited",
              detail: `Card link (${seed.viaCardName}) ${link.relation} ${arrow} ${seedEntry.name}`,
              score: hopScore,
              fromRef: seedRef,
              relation: link.relation,
            }
          : {
              kind: "graph_1hop",
              detail: `1-hop ${link.relation} ${arrow} ${seedEntry.name}`,
              score: hopScore,
              fromRef: seedRef,
              relation: link.relation,
            };

        const existing = oneHopByRef.get(link.neighborRef);
        if (existing) {
          existing.score = Math.max(existing.score, hopScore);
          existing.reasons.push(reason);
          existing.viaRefs.add(seedRef);
        } else {
          oneHopByRef.set(link.neighborRef, {
            entry: neighborEntry,
            score: hopScore,
            reasons: [reason],
            viaRefs: new Set([seedRef]),
          });
        }
      }
    }
  }

  const rankedConstants = [...directCandidates.values()]
    .filter((item) => item.tier === "constant")
    .sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100) || a.entry.name.localeCompare(b.entry.name));
  const rankedLocation = [...directCandidates.values()]
    .filter((item) => item.tier === "location")
    .sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100) || a.entry.name.localeCompare(b.entry.name));
  const rankedDirect = [...directCandidates.values()]
    .filter((item) => item.tier === "direct")
    .sort((a, b) => b.score - a.score || (a.entry.order ?? 100) - (b.entry.order ?? 100));
  const rankedOneHop = [...oneHopByRef.values()].sort(
    (a, b) => b.score - a.score || (a.entry.order ?? 100) - (b.entry.order ?? 100),
  );

  const orderedPool: LmRetrievalActivatedItem[] = [
    ...rankedConstants.map((item) => ({
      entry: item.entry,
      tokens: estimateEntryTokens(item.entry),
      score: item.score,
      tier: "constant" as const,
      reasons: item.reasons,
      viaRefs: [],
    })),
    ...rankedLocation.map((item) => ({
      entry: item.entry,
      tokens: estimateEntryTokens(item.entry),
      score: item.score,
      tier: "location" as const,
      reasons: item.reasons,
      viaRefs: [],
    })),
    ...rankedDirect.map((item) => ({
      entry: item.entry,
      tokens: estimateEntryTokens(item.entry),
      score: item.score,
      tier: "direct" as const,
      reasons: item.reasons,
      viaRefs: [],
    })),
    ...rankedOneHop.map((item) => ({
      entry: item.entry,
      tokens: estimateEntryTokens(item.entry),
      score: item.score,
      tier: "graph_1hop" as const,
      reasons: item.reasons,
      viaRefs: [...item.viaRefs],
    })),
  ];

  const budget = Math.max(1, input.tokenBudget);
  const usedByBook = new Map<string, number>();
  const activated: LmRetrievalActivatedItem[] = [];
  let totalTokens = 0;
  let oneHopCount = 0;
  const maxOneHop = Math.max(0, input.maxOneHop);

  for (const candidate of orderedPool) {
    if (candidate.tier === "graph_1hop" && oneHopCount >= maxOneHop) {
      suppressed.push({
        entry: candidate.entry,
        tokens: candidate.tokens,
        reason: "over_budget",
        detail: `One-hop limit reached (${maxOneHop} neighbours)`,
      });
      continue;
    }
    if (totalTokens + candidate.tokens > budget) {
      suppressed.push({
        entry: candidate.entry,
        tokens: candidate.tokens,
        reason: "over_budget",
        detail: `Exceeds simulation budget (${totalTokens + candidate.tokens} > ${budget} tokens)`,
      });
      continue;
    }
    const bookCap = bookBudgetsById.get(candidate.entry.lorebookId);
    const currentBookUsed = usedByBook.get(candidate.entry.lorebookId) ?? 0;
    if (bookCap !== undefined && currentBookUsed + candidate.tokens > bookCap) {
      suppressed.push({
        entry: candidate.entry,
        tokens: candidate.tokens,
        reason: "over_budget",
        detail: `Exceeds ${candidate.entry.lorebookName} book budget (${bookCap} tokens)`,
      });
      continue;
    }
    totalTokens += candidate.tokens;
    usedByBook.set(candidate.entry.lorebookId, currentBookUsed + candidate.tokens);
    activated.push(candidate);
    if (candidate.tier === "graph_1hop") oneHopCount += 1;
  }

  return {
    activated,
    suppressed,
    totalTokens,
    tokenBudget: budget,
    durationMs: Math.max(0, nowMs() - startedAt),
    cardInheritedSeedRefs: [...cardInheritedSeeds.keys()],
  };
}
