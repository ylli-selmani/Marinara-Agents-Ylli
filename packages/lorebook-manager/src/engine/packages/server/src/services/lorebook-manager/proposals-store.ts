import type {
  LmProposal,
  LmProposalInput,
  LmProposalStatus,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { CompendiumStoreError, LOREBOOK_MANAGER_PACKAGE_ID } from "./compendiums-store.js";
import type { LorebookManagerDocumentStore, LorebookManagerRuntimeHost } from "./package-runtime.js";

/**
 * Suggested lorebook changes waiting in the Review tab. The Archivist (3d) and Auto-tag & Link (3e) write them when
 * the chat's Review Agent Outputs switch is on; applying one goes through the Engine's own entry write path, which
 * refuses locked entries.
 */
export const PROPOSAL_DOC_KIND = "proposal";
const PROPOSAL_STATUSES: readonly LmProposalStatus[] = ["pending", "applied", "dismissed"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toProposal(id: string, revision: number, raw: unknown): LmProposal | null {
  const data = asRecord(raw);
  const kind = data.kind === "create_entry" || data.kind === "update_entry" ? data.kind : null;
  const status = PROPOSAL_STATUSES.includes(data.status as LmProposalStatus) ? (data.status as LmProposalStatus) : null;
  const lorebookId = typeof data.lorebookId === "string" ? data.lorebookId : "";
  if (!kind || !status || !lorebookId) return null;
  return {
    id,
    revision,
    kind,
    status,
    lorebookId,
    targetEntryId: typeof data.targetEntryId === "string" ? data.targetEntryId : null,
    entryName: typeof data.entryName === "string" ? data.entryName : "",
    patch: asRecord(data.patch),
    reason: typeof data.reason === "string" ? data.reason : "",
    source: data.source === "crawler" ? "crawler" : "archivist",
    chatId: typeof data.chatId === "string" ? data.chatId : null,
    sourceMessageRefs: Array.isArray(data.sourceMessageRefs)
      ? (data.sourceMessageRefs as LmProposal["sourceMessageRefs"])
      : [],
    duplicateOfEntryId: typeof data.duplicateOfEntryId === "string" ? data.duplicateOfEntryId : null,
    before: data.before && typeof data.before === "object" ? asRecord(data.before) : null,
    appliedEntryId: typeof data.appliedEntryId === "string" ? data.appliedEntryId : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    decidedAt: typeof data.decidedAt === "string" ? data.decidedAt : null,
  };
}

function proposalData(proposal: LmProposal): Record<string, unknown> {
  const { id: _id, revision: _revision, ...data } = proposal;
  return data;
}

export async function createProposal(
  documents: LorebookManagerDocumentStore,
  input: LmProposalInput,
  now = new Date().toISOString(),
): Promise<LmProposal> {
  if (input.kind === "update_entry" && !input.targetEntryId) {
    throw new CompendiumStoreError("An update needs targetEntryId", 400);
  }
  const id = `proposal:${crypto.randomUUID()}`;
  const proposal: LmProposal = {
    id,
    revision: 1,
    kind: input.kind,
    status: "pending",
    lorebookId: input.lorebookId,
    targetEntryId: input.targetEntryId ?? null,
    entryName: input.entryName,
    patch: { ...input.patch },
    reason: input.reason ?? "",
    source: input.source,
    chatId: input.chatId ?? null,
    sourceMessageRefs: input.sourceMessageRefs ?? [],
    duplicateOfEntryId: input.duplicateOfEntryId ?? null,
    before: null,
    appliedEntryId: null,
    createdAt: now,
    decidedAt: null,
  };
  const created = await documents.create({
    id,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    kind: PROPOSAL_DOC_KIND,
    name: input.entryName || "Lorebook change",
    description: "",
    data: proposalData(proposal),
    createdAt: now,
    updatedAt: now,
  });
  return { ...proposal, revision: created.revision };
}

export async function listProposals(
  documents: LorebookManagerDocumentStore,
  status?: LmProposalStatus,
): Promise<LmProposal[]> {
  const docs = await documents.list(LOREBOOK_MANAGER_PACKAGE_ID, PROPOSAL_DOC_KIND);
  return docs
    .map((doc) => toProposal(doc.id, doc.revision, doc.data))
    .filter((proposal): proposal is LmProposal => proposal !== null && (!status || proposal.status === status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadPending(documents: LorebookManagerDocumentStore, id: string): Promise<LmProposal> {
  const doc = await documents.getById(LOREBOOK_MANAGER_PACKAGE_ID, id);
  const proposal = doc && doc.kind === PROPOSAL_DOC_KIND ? toProposal(doc.id, doc.revision, doc.data) : null;
  if (!proposal) throw new CompendiumStoreError("Suggestion not found", 404);
  if (proposal.status !== "pending") throw new CompendiumStoreError("This suggestion was already handled", 409);
  return proposal;
}

async function saveDecision(documents: LorebookManagerDocumentStore, next: LmProposal): Promise<LmProposal> {
  const updated = await documents.update({
    id: next.id,
    packageId: LOREBOOK_MANAGER_PACKAGE_ID,
    expectedRevision: next.revision,
    name: next.entryName || "Lorebook change",
    description: "",
    data: proposalData(next),
    updatedAt: next.decidedAt ?? new Date().toISOString(),
  });
  if (!updated) throw new CompendiumStoreError("Suggestion changed meanwhile; reload and try again", 409);
  return { ...next, revision: updated.revision };
}

export async function dismissProposal(documents: LorebookManagerDocumentStore, id: string): Promise<LmProposal> {
  const proposal = await loadPending(documents, id);
  return saveDecision(documents, { ...proposal, status: "dismissed", decidedAt: new Date().toISOString() });
}

/**
 * Apply one suggestion through the Engine. For an update, the fields it changes are snapshotted first (`before`), so
 * Activity can offer Undo later. The Engine refuses a locked entry; that error is reported, and the suggestion stays
 * pending.
 */
export async function applyProposal(runtime: LorebookManagerRuntimeHost, id: string): Promise<LmProposal> {
  const documents = runtime.persistence.documents;
  const { createLorebookEntry, updateLorebookEntry, listLorebooks } = runtime.resources;
  if (typeof createLorebookEntry !== "function" || typeof updateLorebookEntry !== "function") {
    throw new CompendiumStoreError("Applying suggestions needs a newer Marinara Engine (Capability API 1.839)", 501);
  }
  const proposal = await loadPending(documents, id);
  const decidedAt = new Date().toISOString();

  if (proposal.kind === "create_entry") {
    const created = await createLorebookEntry(proposal.lorebookId, { name: proposal.entryName, ...proposal.patch });
    return saveDecision(documents, { ...proposal, status: "applied", appliedEntryId: created.id, decidedAt });
  }

  const [book] = await listLorebooks([proposal.lorebookId]);
  const current = (book?.entries ?? [])
    .map((entry) => asRecord(entry))
    .find((entry) => entry.id === proposal.targetEntryId);
  if (!current) throw new CompendiumStoreError("The entry this suggestion changes no longer exists", 404);
  const before = Object.fromEntries(Object.keys(proposal.patch).map((key) => [key, current[key] ?? null]));
  try {
    const updated = await updateLorebookEntry(proposal.targetEntryId!, proposal.patch);
    if (!updated) throw new CompendiumStoreError("The entry this suggestion changes no longer exists", 404);
  } catch (error) {
    if (error instanceof CompendiumStoreError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CompendiumStoreError(message || "The Engine refused this change", 409);
  }
  return saveDecision(documents, {
    ...proposal,
    status: "applied",
    before,
    appliedEntryId: proposal.targetEntryId,
    decidedAt,
  });
}
