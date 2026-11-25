import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Loader2, Save, Sparkles, Trash2, X } from "lucide-react";
import {
  collectLinkedCastForLorebooks,
  DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS,
  normalizeBookTokenBudgets,
} from "../../../../shared/src/features/agents/lorebook-manager/compendium-helpers.js";
import type {
  LmCompendium,
  LmCompendiumRetrievalSettings,
  LmEntityNode,
  LmEntryNode,
  LmLorebookSummary,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchLorebookManagerGraph, type LmCompendiumSavePayload } from "./api";
import { confirmWithHostOrBrowser, getHostComponents } from "./host-components";

const MODAL_STYLE = `
[data-lm-compendium-body] {
  max-height: 70vh;
  overflow-y: auto;
  padding-right: 0.25rem;
}
`;

export interface CompendiumModalProps {
  open: boolean;
  compendium: LmCompendium | null;
  lorebooks: readonly LmLorebookSummary[];
  loadedEntries: readonly LmEntryNode[];
  characters: readonly LmEntityNode[];
  personas: readonly LmEntityNode[];
  saving: boolean;
  onClose: () => void;
  onSave: (payload: LmCompendiumSavePayload, existingId?: string) => Promise<void>;
  onDelete?: (compendium: LmCompendium) => Promise<void>;
}

function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function addUniqueIds(list: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(list);
  const next = [...list];
  for (const id of incoming) {
    if (id.trim() && !seen.has(id.trim())) {
      seen.add(id.trim());
      next.push(id.trim());
    }
  }
  return next;
}

export function CompendiumModal({
  open,
  compendium,
  lorebooks,
  loadedEntries,
  characters,
  personas,
  saving,
  onClose,
  onSave,
  onDelete,
}: CompendiumModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lorebookIds, setLorebookIds] = useState<string[]>([]);
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [personaIds, setPersonaIds] = useState<string[]>([]);
  // Latest committed ids, read after the awaited cast scan so the "added N" counts match what the setters merge into.
  const latestCastRef = useRef({ characterIds: [] as string[], personaIds: [] as string[] });
  latestCastRef.current = { characterIds, personaIds };
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.tokenBudget);
  const [maxOneHop, setMaxOneHop] = useState(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxOneHop);
  const [maxTextHits, setMaxTextHits] = useState(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxTextHits);
  const [respectBookBudgets, setRespectBookBudgets] = useState(
    DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.respectBookBudgets,
  );
  const [bookTokenBudgets, setBookTokenBudgets] = useState<Record<string, number>>({});
  const [discoveringCast, setDiscoveringCast] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (compendium) {
      setName(compendium.name);
      setDescription(compendium.description);
      setLorebookIds(compendium.lorebookIds);
      setCharacterIds(compendium.characterIds);
      setPersonaIds(compendium.personaIds);
      setTokenBudget(compendium.retrievalSettings.tokenBudget);
      setMaxOneHop(compendium.retrievalSettings.maxOneHop);
      setMaxTextHits(compendium.retrievalSettings.maxTextHits);
      setRespectBookBudgets(compendium.retrievalSettings.respectBookBudgets);
      setBookTokenBudgets(compendium.retrievalSettings.bookTokenBudgets);
    } else {
      setName("");
      setDescription("");
      setLorebookIds([]);
      setCharacterIds([]);
      setPersonaIds([]);
      setTokenBudget(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.tokenBudget);
      setMaxOneHop(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxOneHop);
      setMaxTextHits(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.maxTextHits);
      setRespectBookBudgets(DEFAULT_COMPENDIUM_RETRIEVAL_SETTINGS.respectBookBudgets);
      setBookTokenBudgets({});
    }
  }, [open, compendium]);

  const lorebooksById = useMemo(() => new Map(lorebooks.map((book) => [book.id, book])), [lorebooks]);

  const hostComponents = getHostComponents();
  const HostModal = hostComponents.Modal;
  const HostCharacterSelect = hostComponents.CharacterSelect;
  const HostLorebookListField = hostComponents.LorebookListField;

  useEffect(() => {
    if (!open || HostModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [HostModal, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  const selectedBookRows = lorebookIds.map((id) => ({
    id,
    book: lorebooksById.get(id) ?? null,
  }));

  const handleAddLinkedCast = async () => {
    if (lorebookIds.length === 0) {
      toast.info("Choose one or more lorebooks first.");
      return;
    }
    setDiscoveringCast(true);
    try {
      let scanEntries: readonly LmEntryNode[] = loadedEntries;
      const missingBookIds = lorebookIds.filter((id) => !lorebooksById.get(id)?.loaded);
      if (missingBookIds.length > 0) {
        const fetched = await fetchLorebookManagerGraph({
          lorebookIds: missingBookIds,
          characterIds: [],
          personaIds: [],
        });
        scanEntries = [
          ...loadedEntries,
          ...fetched.nodes.filter((node): node is LmEntryNode => node.nodeType === "lore"),
        ];
      }
      const linked = collectLinkedCastForLorebooks(lorebooks, lorebookIds, scanEntries);
      const latest = latestCastRef.current;
      const addedChars = addUniqueIds(latest.characterIds, linked.characterIds).length - latest.characterIds.length;
      const addedPersonas = addUniqueIds(latest.personaIds, linked.personaIds).length - latest.personaIds.length;
      setCharacterIds((prev) => addUniqueIds(prev, linked.characterIds));
      setPersonaIds((prev) => addUniqueIds(prev, linked.personaIds));
      if (addedChars === 0 && addedPersonas === 0) {
        toast.info("No additional linked Character Cards or Personas found for those lorebooks.");
      } else {
        toast.success(`Added ${addedChars} character card(s) and ${addedPersonas} persona(s) from lorebooks.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not scan lorebooks for linked cast");
    } finally {
      setDiscoveringCast(false);
    }
  };

  const handleBookBudgetChange = (bookId: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setBookTokenBudgets((prev) => {
        if (!(bookId in prev)) return prev;
        const next = { ...prev };
        delete next[bookId];
        return next;
      });
      return;
    }
    const num = Math.round(Number(trimmed));
    if (!Number.isFinite(num) || num <= 0) return;
    setBookTokenBudgets((prev) => ({ ...prev, [bookId]: num }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      toast.error("Give this Compendium a name.");
      return;
    }
    const filteredBookBudgets: Record<string, number> = {};
    const normalizedBudgets = normalizeBookTokenBudgets(bookTokenBudgets);
    for (const bookId of lorebookIds) {
      if (normalizedBudgets[bookId]) filteredBookBudgets[bookId] = normalizedBudgets[bookId];
    }
    const retrievalSettings: LmCompendiumRetrievalSettings = {
      tokenBudget: Math.max(100, Math.min(128000, Math.round(tokenBudget))),
      maxOneHop: Math.max(0, Math.min(20, Math.round(maxOneHop))),
      maxTextHits: Math.max(0, Math.min(25, Math.round(maxTextHits))),
      respectBookBudgets,
      bookTokenBudgets: filteredBookBudgets,
    };
    await onSave(
      {
        name: cleanName,
        description: description.trim(),
        lorebookIds,
        characterIds,
        personaIds,
        retrievalSettings,
        expectedRevision: compendium?.revision,
      },
      compendium?.id,
    );
  };

  const handleDelete = async () => {
    if (!compendium || !onDelete) return;
    const confirmed = await confirmWithHostOrBrowser({
      title: `Delete "${compendium.name}"?`,
      message: "Your lorebooks, Character Cards, and Personas stay untouched; only this Compendium bundle is removed.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!confirmed) return;
    await onDelete(compendium);
  };

  const formContent = (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4 text-xs">
      <style>{MODAL_STYLE}</style>
      <div data-lm-compendium-body className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="font-medium text-[var(--muted-foreground)]">Name</span>
            <input
              type="text"
              required
              disabled={saving}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. U.A. Sports Festival Arc"
              className="mari-chrome-field h-9 w-full rounded px-2.5 text-sm md:text-xs"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-medium text-[var(--muted-foreground)]">Description (optional)</span>
            <input
              type="text"
              disabled={saving}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Books, cast, and budget for this campaign"
              className="mari-chrome-field h-9 w-full rounded px-2.5 text-sm md:text-xs"
            />
          </label>
        </div>

        <div className="space-y-1.5">
          <span className="block font-medium text-[var(--muted-foreground)]">Lorebooks</span>
          {HostLorebookListField ? (
            <HostLorebookListField
              lorebooks={lorebooks.map((book) => ({
                id: book.id,
                name: book.name,
                imagePath: book.imagePath ?? null,
                imageCrop: book.imageCrop ?? null,
                enabled: book.enabled,
              }))}
              selectedIds={lorebookIds}
              onToggle={(id) => setLorebookIds((prev) => toggleId(prev, id))}
              onAdd={(ids) => setLorebookIds((prev) => addUniqueIds(prev, ids))}
              onApplySet={(ids) => setLorebookIds([...new Set(ids)])}
              triggerClassName="mari-chrome-field min-h-10 w-full min-w-0 rounded-lg px-3 py-2 text-base md:text-xs disabled:cursor-not-allowed disabled:opacity-60"
              ariaLabel="Compendium lorebooks"
              keepMissing
              disabled={saving}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {lorebooks.map((book) => {
                const active = lorebookIds.includes(book.id);
                return (
                  <button
                    key={book.id}
                    type="button"
                    disabled={saving}
                    aria-pressed={active}
                    onClick={() => setLorebookIds((prev) => toggleId(prev, book.id))}
                    className="mari-chrome-control mari-chrome-control--small"
                  >
                    {book.name} ({book.entryCount})
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="block font-medium text-[var(--foreground)]">Cast in this Compendium</span>
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                Scoped to the graph and mention scan when this Compendium is selected.
              </span>
            </div>
            <button
              type="button"
              disabled={saving || discoveringCast || lorebookIds.length === 0}
              onClick={() => void handleAddLinkedCast()}
              className="mari-chrome-control mari-chrome-control--small disabled:opacity-50"
            >
              {discoveringCast ? <Loader2 size="0.75rem" className="animate-spin" /> : <Sparkles size="0.75rem" />}
              Add linked cards & personas
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="block font-medium text-[var(--muted-foreground)]">Character Cards</span>
              {HostCharacterSelect ? (
                <HostCharacterSelect
                  kind="character"
                  multiple
                  value={characterIds}
                  onChange={setCharacterIds}
                  placeholder="Pick character cards…"
                  aria-label="Compendium character cards"
                  disabled={saving}
                />
              ) : (
                <div className="flex flex-wrap gap-1">
                  {characters.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      aria-pressed={characterIds.includes(card.id)}
                      onClick={() => setCharacterIds((prev) => toggleId(prev, card.id))}
                      className="mari-chrome-control mari-chrome-control--small"
                    >
                      {card.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <span className="block font-medium text-[var(--muted-foreground)]">Personas</span>
              {HostCharacterSelect ? (
                <HostCharacterSelect
                  kind="persona"
                  multiple
                  value={personaIds}
                  onChange={setPersonaIds}
                  placeholder="Pick personas…"
                  aria-label="Compendium personas"
                  disabled={saving}
                />
              ) : (
                <div className="flex flex-wrap gap-1">
                  {personas.map((persona) => (
                    <button
                      key={persona.id}
                      type="button"
                      aria-pressed={personaIds.includes(persona.id)}
                      onClick={() => setPersonaIds((prev) => toggleId(prev, persona.id))}
                      className="mari-chrome-control mari-chrome-control--small"
                    >
                      {persona.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2.5 rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-3">
          <div className="font-medium text-[var(--foreground)]">Retrieval & Token Budgets</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">Token budget</span>
              <input
                type="number"
                min={100}
                max={128000}
                step={1}
                disabled={saving}
                value={tokenBudget}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setTokenBudget(next);
                }}
                className="mari-chrome-field h-8 w-24 rounded px-2 text-xs tabular-nums"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">Max 1-hop bonus</span>
              <input
                type="number"
                min={0}
                max={20}
                step={1}
                disabled={saving}
                value={maxOneHop}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setMaxOneHop(next);
                }}
                className="mari-chrome-field h-8 w-16 rounded px-2 text-xs tabular-nums"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">Max text hits</span>
              <input
                type="number"
                min={0}
                max={25}
                step={1}
                disabled={saving}
                value={maxTextHits}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setMaxTextHits(next);
                }}
                className="mari-chrome-field h-8 w-16 rounded px-2 text-xs tabular-nums"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
            <input
              type="checkbox"
              disabled={saving}
              checked={respectBookBudgets}
              onChange={(event) => setRespectBookBudgets(event.target.checked)}
            />
            <span>Respect each lorebook&apos;s own token budget when no override is set</span>
          </label>

          {selectedBookRows.length > 0 ? (
            <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
              <span className="block text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                Per-lorebook token budget overrides (leave blank for native default)
              </span>
              <div className="space-y-1">
                {selectedBookRows.map(({ id, book }) => {
                  const nativeBudget = book?.tokenBudget;
                  const nativeLabel =
                    typeof nativeBudget === "number" && nativeBudget > 0
                      ? `Native: ${nativeBudget} tok`
                      : "Native: unlimited";
                  const overrideValue = bookTokenBudgets[id] ?? "";
                  return (
                    <div key={`budget-${id}`} className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-[var(--foreground)]">{book?.name ?? id}</span>
                        <span className="ml-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">({nativeLabel})</span>
                      </div>
                      <input
                        type="number"
                        min={50}
                        max={128000}
                        step={1}
                        disabled={saving}
                        value={overrideValue}
                        placeholder="Default"
                        aria-label={`Token budget override for ${book?.name ?? id}`}
                        onChange={(event) => handleBookBudgetChange(id, event.target.value)}
                        className="mari-chrome-field h-7 w-24 rounded px-2 text-xs tabular-nums"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
        <div>
          {compendium && onDelete ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleDelete()}
              className="mari-chrome-control mari-chrome-control--small text-[var(--destructive)]"
            >
              <Trash2 size="0.75rem" />
              Delete Compendium
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="mari-chrome-control mari-chrome-control--small"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="mari-chrome-control mari-chrome-control--small font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 size="0.75rem" className="animate-spin" /> : <Save size="0.75rem" />}
            {compendium ? "Save Compendium" : "Create Compendium"}
          </button>
        </div>
      </div>
    </form>
  );

  const modalTitle = compendium ? `Edit Compendium: ${compendium.name}` : "New Compendium";

  if (HostModal) {
    return (
      <HostModal open onClose={onClose} title={modalTitle} width="max-w-2xl" mobileFullscreen>
        {formContent}
      </HostModal>
    );
  }

  return createPortal(
    <div
      style={{ zIndex: 1100 }}
      className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{modalTitle}</h2>
          <button
            type="button"
            aria-label="Close"
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
            onClick={onClose}
          >
            <X size="0.875rem" />
          </button>
        </div>
        {formContent}
      </div>
    </div>,
    document.body,
  );
}
