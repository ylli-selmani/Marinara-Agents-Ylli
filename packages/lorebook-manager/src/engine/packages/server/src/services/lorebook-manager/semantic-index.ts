import { createHash } from "node:crypto";
import type {
  LmSemanticIndexStatus,
  LmSemanticRunInfo,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { CompendiumStoreError, LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import { getLorebookManagerRuntime, type LorebookManagerEmbeddingHost } from "./package-runtime.js";

/**
 * Meaning match (Slice 3c): entry vectors for Stage 1's semantic lane.
 *
 * An entry's vector comes from the Engine when the Engine already vectorized it in the same embedding space (its own
 * lorebook vectors, `embedding` + `embeddingSpaceId`), otherwise from this package's cache: one document per lorebook
 * and space, keyed by entry id and a hash of the embedded text. Missing vectors are filled in the background or by
 * Index now, never on the turn path. A turn embeds only the query, against a deadline, and falls back to text matching.
 */

export const VECTOR_DOC_KIND = "vectors";
export const LIVE_QUERY_TIMEOUT_MS = 1000;
const MAX_QUERY_CHARS = 4000;
const MAX_ENTRY_TEXT_CHARS = 6000;
// The host refuses more than 128 texts or 200k characters per call, and answers null instead of throwing.
const BATCH_MAX_TEXTS = 32;
const BATCH_MAX_CHARS = 120_000;
const FAILURE_COOLDOWN_MS = 60_000;

// The Engine's own calibration texts (services/lorebook/embeddings.ts): deliberately unrelated sentences whose mutual
// similarity estimates the model's cosine floor, so one threshold means the same across models.
const CALIBRATION_TEXTS = [
  "A recipe explains how to bake a loaf of bread.",
  "A spacecraft studies distant galaxies and nebulae.",
  "A city council reviews municipal zoning regulations.",
];

/** What the graph builder keeps from each raw Engine entry for the semantic lane. Never sent to the client. */
export interface EntryVectorSource {
  entryId: string;
  lorebookId: string;
  text: string;
  engineEmbedding: number[] | null;
  engineSpaceId: string | null;
  excluded: boolean;
  /** The whole book is switched off (the Engine's per-lorebook Vectors switch), not just this entry. */
  bookExcluded: boolean;
}

type CachedVector = { h: string; v: string };
interface VectorDocData {
  lorebookId: string;
  spaceId: string;
  dims: number;
  vectors: Record<string, CachedVector>;
}
interface DecodedDoc {
  revision: number;
  vectors: Map<string, { h: string; v: Float32Array }>;
}

const decodedDocs = new Map<string, DecodedDoc>();
const baselineBySpace = new Map<string, number>();
const inFlightIndex = new Map<string, Promise<{ embedded: number; failed: number }>>();
const failedAt = new Map<string, number>();

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function vectorDocId(lorebookId: string, spaceId: string): string {
  return `vectors:${lorebookId}:${sha(spaceId).slice(0, 16)}`;
}

function encodeVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

function textList(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .join(", ")
    : "";
}

/** The same fields, in the same order, as the Engine's `buildLorebookEntryEmbeddingText`. */
export function entryEmbeddingText(entry: Record<string, unknown>): string {
  const parts: Array<[string, string]> = [
    ["Name", typeof entry.name === "string" ? entry.name.trim() : ""],
    ["Description", typeof entry.description === "string" ? entry.description.trim() : ""],
    ["Keys", textList(entry.keys)],
    ["Secondary Keys", textList(entry.secondaryKeys)],
    ["Content", typeof entry.content === "string" ? entry.content.trim() : ""],
  ];
  return parts
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}: ${text}`)
    .join("\n\n")
    .slice(0, MAX_ENTRY_TEXT_CHARS);
}

export function entryVectorSource(
  lorebookId: string,
  bookData: Record<string, unknown>,
  entry: Record<string, unknown>,
): EntryVectorSource | null {
  const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!entryId) return null;
  const embedding = Array.isArray(entry.embedding) && entry.embedding.length > 0 ? (entry.embedding as number[]) : null;
  return {
    entryId,
    lorebookId,
    text: entryEmbeddingText(entry),
    engineEmbedding: embedding,
    engineSpaceId: typeof entry.embeddingSpaceId === "string" ? entry.embeddingSpaceId : null,
    excluded: bookData.excludeFromVectorization === true || entry.excludeFromVectorization === true,
    bookExcluded: bookData.excludeFromVectorization === true,
  };
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function similarityBaseline(embeddings: ReadonlyArray<ArrayLike<number>>): number {
  let sum = 0;
  let count = 0;
  for (let left = 0; left < embeddings.length; left++) {
    for (let right = left + 1; right < embeddings.length; right++) {
      const similarity = cosine(embeddings[left]!, embeddings[right]!);
      if (Number.isFinite(similarity)) {
        sum += similarity;
        count += 1;
      }
    }
  }
  return count === 0 ? 0 : Math.max(0, Math.min(0.999, sum / count));
}

/** Same mapping as the Engine's `calibrateLorebookSimilarity`. */
function calibrate(similarity: number, baseline: number): number {
  if (!Number.isFinite(similarity)) return 0;
  const calibrated = (Math.max(-1, Math.min(1, similarity)) - baseline) / (1 - baseline);
  return Math.max(0, Math.min(1, calibrated));
}

async function resolveHost(): Promise<LorebookManagerEmbeddingHost | null> {
  const runtime = getLorebookManagerRuntime();
  if (typeof runtime.resolveEmbeddings === "function") return runtime.resolveEmbeddings();
  return runtime.embeddings ?? null;
}

async function loadDoc(lorebookId: string, spaceId: string): Promise<DecodedDoc | null> {
  const { documents } = getLorebookManagerRuntime().persistence;
  const id = vectorDocId(lorebookId, spaceId);
  const record = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  if (!record) {
    decodedDocs.delete(id);
    return null;
  }
  const cached = decodedDocs.get(id);
  if (cached && cached.revision === record.revision) return cached;
  const data = (record.data ?? {}) as Partial<VectorDocData>;
  const vectors = new Map<string, { h: string; v: Float32Array }>();
  if (data.spaceId === spaceId && data.vectors && typeof data.vectors === "object") {
    for (const [entryId, item] of Object.entries(data.vectors)) {
      if (item && typeof item.h === "string" && typeof item.v === "string") {
        vectors.set(entryId, { h: item.h, v: decodeVector(item.v) });
      }
    }
  }
  const decoded = { revision: record.revision, vectors };
  decodedDocs.set(id, decoded);
  return decoded;
}

interface ResolvedVectors {
  vectors: Map<string, ArrayLike<number>>;
  engineCount: number;
  excluded: number;
  missing: Array<EntryVectorSource & { h: string }>;
}

async function resolveVectors(sources: readonly EntryVectorSource[], spaceId: string): Promise<ResolvedVectors> {
  const vectors = new Map<string, ArrayLike<number>>();
  const missing: ResolvedVectors["missing"] = [];
  let engineCount = 0;
  let excluded = 0;
  const docs = new Map<string, DecodedDoc | null>();
  for (const source of sources) {
    if (source.excluded || !source.text) {
      excluded += 1;
      continue;
    }
    if (source.engineEmbedding && source.engineSpaceId === spaceId) {
      vectors.set(source.entryId, source.engineEmbedding);
      engineCount += 1;
      continue;
    }
    if (!docs.has(source.lorebookId)) docs.set(source.lorebookId, await loadDoc(source.lorebookId, spaceId));
    const h = sha(source.text);
    const cached = docs.get(source.lorebookId)?.vectors.get(source.entryId);
    if (cached && cached.h === h) vectors.set(source.entryId, cached.v);
    else missing.push({ ...source, h });
  }
  return { vectors, engineCount, excluded, missing };
}

async function writeVectors(
  lorebookId: string,
  spaceId: string,
  additions: Map<string, CachedVector>,
  dims: number,
): Promise<void> {
  const { documents } = getLorebookManagerRuntime().persistence;
  const id = vectorDocId(lorebookId, spaceId);
  // Two tries: a concurrent writer (another Index now) bumps the revision; re-read and merge.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
    const previous = ((existing?.data ?? {}) as Partial<VectorDocData>).vectors ?? {};
    const vectors: Record<string, CachedVector> = { ...previous, ...Object.fromEntries(additions) };
    const data: VectorDocData = { lorebookId, spaceId, dims, vectors };
    const at = new Date().toISOString();
    if (!existing) {
      await documents.create({
        id,
        packageId: LOREBOOK_MANAGER_PACKAGE_ID,
        kind: VECTOR_DOC_KIND,
        name: `Vectors for lorebook ${lorebookId}`,
        description: "",
        data,
        createdAt: at,
        updatedAt: at,
      });
      decodedDocs.delete(id);
      return;
    }
    const updated = await documents.update({
      id,
      packageId: LOREBOOK_MANAGER_PACKAGE_ID,
      expectedRevision: existing.revision,
      name: existing.name,
      description: "",
      data,
      updatedAt: at,
    });
    if (updated) {
      decodedDocs.delete(id);
      return;
    }
  }
  throw new Error(`Could not save vectors for lorebook ${lorebookId}: it kept changing`);
}

async function warmBaseline(host: LorebookManagerEmbeddingHost): Promise<number | null> {
  const known = baselineBySpace.get(host.spaceId);
  if (known !== undefined) return known;
  const embedded = await host.embed(CALIBRATION_TEXTS, undefined, "query");
  if (!embedded || embedded.length !== CALIBRATION_TEXTS.length) return null;
  const baseline = similarityBaseline(embedded);
  baselineBySpace.set(host.spaceId, baseline);
  return baseline;
}

async function embedMissing(
  host: LorebookManagerEmbeddingHost,
  missing: ResolvedVectors["missing"],
): Promise<{ embedded: number; failed: number }> {
  let embedded = 0;
  let failed = 0;
  const byBook = new Map<string, ResolvedVectors["missing"]>();
  for (const item of missing) byBook.set(item.lorebookId, [...(byBook.get(item.lorebookId) ?? []), item]);
  for (const [lorebookId, items] of byBook) {
    const additions = new Map<string, CachedVector>();
    let dims = 0;
    let index = 0;
    while (index < items.length) {
      const batch: typeof items = [];
      let chars = 0;
      while (index < items.length && batch.length < BATCH_MAX_TEXTS) {
        const next = items[index]!;
        if (batch.length > 0 && chars + next.text.length > BATCH_MAX_CHARS) break;
        batch.push(next);
        chars += next.text.length;
        index += 1;
      }
      const vectors = await host.embed(
        batch.map((item) => item.text),
        undefined,
        "document",
      );
      if (!vectors || vectors.length !== batch.length) {
        failed += batch.length;
        continue;
      }
      batch.forEach((item, position) => {
        const vector = vectors[position];
        if (!vector || vector.length === 0) {
          failed += 1;
          return;
        }
        dims = vector.length;
        additions.set(item.entryId, { h: item.h, v: encodeVector(vector) });
      });
    }
    if (additions.size > 0) {
      await writeVectors(lorebookId, host.spaceId, additions, dims);
      embedded += additions.size;
    }
  }
  return { embedded, failed };
}

/** Fill missing vectors once per book and space at a time; after a failure, wait a minute before trying again. */
function scheduleIndex(host: LorebookManagerEmbeddingHost, missing: ResolvedVectors["missing"]): void {
  const key = `${host.spaceId}\u0000${[...new Set(missing.map((item) => item.lorebookId))].sort().join(",")}`;
  if (inFlightIndex.has(key)) return;
  const lastFailure = failedAt.get(key);
  if (lastFailure && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) return;
  const run = (async () => {
    await warmBaseline(host).catch(() => null);
    return embedMissing(host, missing);
  })();
  inFlightIndex.set(key, run);
  run
    .then((result) => {
      if (result.failed > 0) failedAt.set(key, Date.now());
      else failedAt.delete(key);
    })
    .catch((error) => {
      failedAt.set(key, Date.now());
      getLorebookManagerRuntime().logger.warn("[lorebook-manager] Background indexing failed: %s", error);
    })
    .finally(() => inFlightIndex.delete(key));
}

function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race a timer too: an embedder may ignore the abort signal (the local one runs to completion).
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

export interface SemanticScoresResult {
  /** Calibrated similarity per entry ref (`lore:<id>`); empty unless status is "used". */
  scores: Record<string, number>;
  info: LmSemanticRunInfo;
}

/**
 * Similarities of the query to every vectorized entry. Never throws: any failure comes back as a status, and Stage 1
 * then runs on text matching alone, as it did before this lane.
 */
export async function semanticScoresFor(
  sources: readonly EntryVectorSource[],
  /** One query, or several embedded in one call; each entry keeps its best score (the Engine's character context). */
  queryText: string | readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<SemanticScoresResult> {
  const startedAt = Date.now();
  const empty = (info: Partial<LmSemanticRunInfo> & Pick<LmSemanticRunInfo, "status">): SemanticScoresResult => ({
    scores: {},
    info: { embedMs: 0, vectorCount: 0, engineVectorCount: 0, missingCount: 0, ...info },
  });
  const queries = [
    ...new Set(
      (typeof queryText === "string" ? [queryText] : queryText)
        .map((text) => text.trim().slice(-MAX_QUERY_CHARS))
        .filter(Boolean),
    ),
  ];
  if (queries.length === 0) return empty({ status: "no_vectors", detail: "No message text to match" });
  try {
    const host = await resolveHost();
    if (!host) return empty({ status: "error", detail: "This Engine has no embedding host" });
    const resolved = await resolveVectors(sources, host.spaceId);
    if (resolved.missing.length > 0) scheduleIndex(host, resolved.missing);
    const counts = {
      vectorCount: resolved.vectors.size,
      engineVectorCount: resolved.engineCount,
      missingCount: resolved.missing.length,
    };
    if (resolved.vectors.size === 0) {
      return empty({
        status: "no_vectors",
        ...counts,
        detail:
          resolved.missing.length > 0
            ? "Vectorizing in the background"
            : "No entry here can be found by meaning: the lorebooks' Vectors switch is off",
      });
    }

    const knownBaseline = baselineBySpace.get(host.spaceId);
    const texts = knownBaseline === undefined ? [...queries, ...CALIBRATION_TEXTS] : queries;
    const embedStarted = Date.now();
    const outcome = await withDeadline(
      (signal) => host.embed(texts, signal, "query"),
      options.timeoutMs ?? LIVE_QUERY_TIMEOUT_MS,
    );
    const embedMs = Date.now() - embedStarted;
    if (outcome === "timeout") {
      // Warm the model and the baseline for the next turn (the first local embed loads the model).
      void warmBaseline(host).catch(() => null);
      return empty({ status: "timeout", embedMs, ...counts });
    }
    const queryVectors = outcome && outcome.length === texts.length ? outcome.slice(0, queries.length) : [];
    if (queryVectors.length === 0 || queryVectors.some((vector) => !vector?.length)) {
      return empty({ status: "error", embedMs, ...counts, detail: "The embedding request failed" });
    }
    let baseline = knownBaseline;
    if (baseline === undefined) {
      baseline = similarityBaseline(outcome!.slice(queries.length));
      baselineBySpace.set(host.spaceId, baseline);
    }
    const scores: Record<string, number> = {};
    for (const [entryId, vector] of resolved.vectors) {
      let best: number | null = null;
      for (const queryVector of queryVectors) {
        if (vector.length !== queryVector.length) continue;
        const similarity = calibrate(cosine(queryVector, vector), baseline);
        if (best === null || similarity > best) best = similarity;
      }
      if (best !== null) scores[`lore:${entryId}`] = Math.round(best * 1000) / 1000;
    }
    return { scores, info: { status: "used", embedMs, ...counts } };
  } catch (error) {
    return empty({
      status: "error",
      embedMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message.slice(0, 160) : "Unknown error",
    });
  }
}

/**
 * The Crawler's meaning targets: for each asked entry, the other entries closest to it by their stored vectors (entry
 * against entry; only the calibration texts are ever embedded, once per model). Uses what is indexed already and never
 * starts indexing. Never throws: empty when nothing is indexed or the host is gone.
 */
export async function similarEntries(
  sources: readonly EntryVectorSource[],
  entryIds: readonly string[],
  options: { limit?: number; minSimilarity?: number; timeoutMs?: number } = {},
): Promise<Map<string, Array<{ entryId: string; similarity: number }>>> {
  const result = new Map<string, Array<{ entryId: string; similarity: number }>>();
  if (entryIds.length === 0 || sources.length < 2) return result;
  try {
    const host = await resolveHost();
    if (!host) return result;
    const { vectors } = await resolveVectors(sources, host.spaceId);
    if (vectors.size < 2) return result;
    let baseline = baselineBySpace.get(host.spaceId);
    if (baseline === undefined) {
      const warmed = await withDeadline(() => warmBaseline(host), options.timeoutMs ?? 10_000);
      if (typeof warmed !== "number") return result;
      baseline = warmed;
    }
    const limit = options.limit ?? 4;
    const min = options.minSimilarity ?? 0.3;
    for (const entryId of entryIds) {
      const own = vectors.get(entryId);
      if (!own) continue;
      const scored: Array<{ entryId: string; similarity: number }> = [];
      for (const [otherId, vector] of vectors) {
        if (otherId === entryId || vector.length !== own.length) continue;
        const similarity = calibrate(cosine(own, vector), baseline);
        if (similarity >= min) scored.push({ entryId: otherId, similarity: Math.round(similarity * 1000) / 1000 });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      if (scored.length > 0) result.set(entryId, scored.slice(0, limit));
    }
  } catch {
    // Meaning targets are extra: the links call still has what the text names.
  }
  return result;
}

/** Index now: embed every missing vector of these books in this call, and report what is indexed. */
export async function indexLorebooks(lorebookIds: readonly string[]): Promise<LmSemanticIndexStatus> {
  const runtime = getLorebookManagerRuntime();
  const host = await resolveHost();
  if (!host) throw new CompendiumStoreError("This Engine has no embedding host", 501);
  const books = lorebookIds.length > 0 ? await runtime.resources.listLorebooks([...lorebookIds]) : [];
  const sources: EntryVectorSource[] = [];
  const excludedBooks: string[] = [];
  for (const book of books) {
    const bookData = (book.data && typeof book.data === "object" ? book.data : {}) as Record<string, unknown>;
    if (bookData.excludeFromVectorization === true) {
      excludedBooks.push(typeof bookData.name === "string" && bookData.name.trim() ? bookData.name.trim() : book.id);
    }
    for (const raw of Array.isArray(book.entries) ? book.entries : []) {
      const source = entryVectorSource(book.id, bookData, (raw ?? {}) as Record<string, unknown>);
      if (source) sources.push(source);
    }
  }
  const before = await resolveVectors(sources, host.spaceId);
  const baseline = await warmBaseline(host).catch(() => null);
  const result = before.missing.length > 0 ? await embedMissing(host, before.missing) : { embedded: 0, failed: 0 };
  return {
    spaceLabel: host.label,
    total: sources.length,
    indexed: before.vectors.size + result.embedded,
    engineVectors: before.engineCount,
    excluded: before.excluded,
    excludedBooks,
    embedded: result.embedded,
    failed: result.failed,
    ...(baseline === null ? { detail: "Could not calibrate this embedding model" } : {}),
  };
}

/** Test hook: forget decoded documents, baselines and cooldowns. */
export function resetSemanticIndexState(): void {
  decodedDocs.clear();
  baselineBySpace.clear();
  inFlightIndex.clear();
  failedAt.clear();
}

/** Test hook: wait for background indexing started by `semanticScoresFor`. */
export async function settleBackgroundIndexing(): Promise<void> {
  await Promise.allSettled([...inFlightIndex.values()]);
}
