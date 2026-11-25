import { parseEntityRef } from "./entity-ref.js";
import type {
  LmEntryNode,
  LmGraphPayload,
  LmRetrievalActivatedItem,
  LmRetrievalInput,
  LmRetrievalReason,
  LmRetrievalResult,
  LmRetrievalSuppressedItem,
} from "./schema.js";

const STOPWORDS = new Set([
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
  "out",
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
  "can",
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
  "now",
  "way",
  "make",
  "made",
  "take",
  "took",
  "come",
  "came",
  "goes",
  "went",
  "gets",
  "got",
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
      let flags = literal ? literal.flags : "";
      if (!options.caseSensitive && !flags.includes("i")) flags += "i";
      if (!flags.includes("u")) flags += "u";
      return new RegExp(pattern, flags).test(text);
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

function tokenizeBm25(text: string): string[] {
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token));
}

function computeBm25Scores(
  entries: readonly LmEntryNode[],
  queryText: string,
): Map<string, { score: number; matchedTerms: string[] }> {
  const scores = new Map<string, { score: number; matchedTerms: string[] }>();
  const queryTerms = [...new Set(tokenizeBm25(queryText))];
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
    return { weight: 0.85, floor: seedMatchedLocation || viaCardInherited ? 0 : 0.4 };
  }
  if (base === "member_of") {
    return { weight: 0.75, floor: viaCardInherited || direction === "out" ? 0 : 1.0 };
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

  const entriesByRef = new Map(scopedEntries.map((entry) => [entry.ref, entry]));
  const eligibleEntries: LmEntryNode[] = [];
  const eligibleSet = new Set<string>();
  const suppressed: LmRetrievalSuppressedItem[] = [];

  for (const entry of scopedEntries) {
    const tokens = estimateEntryTokens(entry);
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

  const bm25Scores = computeBm25Scores(eligibleEntries, queryText);
  const queryTokenCount = tokenizeBm25(queryText).length;
  let topBm25 = 0;
  for (const hit of bm25Scores.values()) {
    if (hit.score > topBm25) topBm25 = hit.score;
  }
  const bm25Floor = queryTokenCount <= 1 ? 1.8 : Math.max(4.0, topBm25 * 0.45);
  const maxTextHits = Math.max(0, input.maxTextHits ?? 5);

  const directCandidates = new Map<
    string,
    {
      entry: LmEntryNode;
      tier: "constant" | "direct";
      score: number;
      reasons: LmRetrievalReason[];
      matchedLocation: boolean;
    }
  >();

  for (const entry of eligibleEntries) {
    const reasons: LmRetrievalReason[] = [];
    let score = 0;
    let tier: "constant" | "direct" | null = null;
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

    if (
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

  for (const [ref, direct] of directCandidates) {
    const bm25Hit = bm25Scores.get(ref);
    if (bm25Hit && bm25Hit.score >= 2.0) {
      direct.score += bm25Hit.score;
      direct.reasons.push(formatBm25Reason(bm25Hit));
    }
  }

  if (maxTextHits > 0) {
    const textOnlyRanked = eligibleEntries
      .filter((entry) => !directCandidates.has(entry.ref))
      .map((entry) => ({ entry, hit: bm25Scores.get(entry.ref) }))
      .filter((item): item is { entry: LmEntryNode; hit: { score: number; matchedTerms: string[] } } =>
        Boolean(item.hit && item.hit.score >= bm25Floor),
      )
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, maxTextHits);

    for (const { entry, hit } of textOnlyRanked) {
      directCandidates.set(entry.ref, {
        entry,
        tier: "direct",
        score: hit.score,
        reasons: [formatBm25Reason(hit)],
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
        const arrow = link.direction === "both" ? "↔" : link.direction === "out" ? "→" : "←";
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
  const rankedDirect = [...directCandidates.values()]
    .filter((item) => item.tier === "direct")
    .sort((a, b) => b.score - a.score || (a.entry.order ?? 100) - (b.entry.order ?? 100));
  const rankedOneHop = [...oneHopByRef.values()]
    .sort((a, b) => b.score - a.score || (a.entry.order ?? 100) - (b.entry.order ?? 100))
    .slice(0, Math.max(0, input.maxOneHop));

  const orderedPool: LmRetrievalActivatedItem[] = [
    ...rankedConstants.map((item) => ({
      entry: item.entry,
      tokens: estimateEntryTokens(item.entry),
      score: item.score,
      tier: "constant" as const,
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

  for (const candidate of orderedPool) {
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
