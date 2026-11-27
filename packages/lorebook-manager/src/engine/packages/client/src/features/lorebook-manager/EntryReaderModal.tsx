import { LmSelect } from "./LmSelect";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Pencil, Save, X } from "lucide-react";
import type { LmEntryNode, LmGraphNode } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import type { LmEntryPatch } from "./api";
import { getHostComponents } from "./host-components";

const TAG_PRESETS = [
  { value: "", label: "Untagged (auto)" },
  { value: "lore", label: "lore" },
  { value: "character", label: "character" },
  { value: "location", label: "location" },
  { value: "faction", label: "faction" },
  { value: "item", label: "item" },
  { value: "creature", label: "creature" },
  { value: "species", label: "species" },
  { value: "ability", label: "ability" },
  { value: "quest", label: "quest" },
] as const;

export interface EntryReaderModalProps {
  node: LmGraphNode | null;
  initialMode: "read" | "edit";
  saving: boolean;
  onClose: () => void;
  onOpenLorebook?: (lorebookId: string, entryId?: string) => void;
  onOpenCharacter?: (characterId: string) => void;
  onOpenPersona?: (personaId: string) => void;
  onUpdateEntry: (entry: LmEntryNode, patch: LmEntryPatch) => Promise<void>;
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function EntryReaderModal({
  node,
  initialMode,
  saving,
  onClose,
  onOpenLorebook,
  onOpenCharacter,
  onOpenPersona,
  onUpdateEntry,
}: EntryReaderModalProps) {
  const [mode, setMode] = useState<"read" | "edit">(initialMode);
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [keysText, setKeysText] = useState("");
  const [secondaryKeysText, setSecondaryKeysText] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [constant, setConstant] = useState(false);
  const lastNodeRef = useRef<string | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Draft values as loaded; Save sends only fields that differ, so a stale draft can't overwrite
  // edits made elsewhere and untouched keys never go through the comma split/join round-trip.
  const baselineRef = useRef<Record<string, string | boolean>>({});

  const resetDraftFromNode = useCallback((target: LmGraphNode) => {
    baselineRef.current =
      target.nodeType === "lore"
        ? {
            name: target.name,
            description: target.description,
            tag: target.tag,
            keysText: target.keys.join(", "),
            secondaryKeysText: target.secondaryKeys.join(", "),
            content: target.content,
            enabled: target.enabled,
            constant: target.constant,
          }
        : { name: target.name, description: target.description };
    setName(target.name);
    setDescription(target.description);
    if (target.nodeType === "lore") {
      setTag(target.tag);
      setKeysText(target.keys.join(", "));
      setSecondaryKeysText(target.secondaryKeys.join(", "));
      setContent(target.content);
      setEnabled(target.enabled);
      setConstant(target.constant);
    }
  }, []);

  useEffect(() => {
    if (!node) {
      lastNodeRef.current = null;
      return;
    }
    if (lastNodeRef.current !== node.ref) {
      lastNodeRef.current = node.ref;
      setMode(node.nodeType === "lore" ? initialMode : "read");
      resetDraftFromNode(node);
    } else if (modeRef.current === "read") {
      resetDraftFromNode(node);
    }
  }, [node, initialMode, resetDraftFromNode]);

  if (!node || typeof document === "undefined") return null;

  const isLore = node.nodeType === "lore";
  const lorebookId = node.nodeType === "lore" ? node.lorebookId : node.nodeType === "lorebook" ? node.id : null;

  const handleSave = async () => {
    if (!isLore) return;
    const base = baselineRef.current;
    const patch: LmEntryPatch = {};
    if (name !== base.name) patch.name = name.trim() || node.name;
    if (tag !== base.tag) patch.tag = tag.trim();
    if (keysText !== base.keysText) patch.keys = parseKeywords(keysText);
    if (secondaryKeysText !== base.secondaryKeysText) patch.secondaryKeys = parseKeywords(secondaryKeysText);
    if (description !== base.description) patch.description = description;
    if (content !== base.content) patch.content = content;
    if (enabled !== base.enabled) patch.enabled = enabled;
    if (constant !== base.constant) patch.constant = constant;
    if (Object.keys(patch).length === 0) {
      setMode("read");
      return;
    }
    try {
      await onUpdateEntry(node, patch);
      setMode("read");
    } catch {
      // LorebookManagerDetail surfaces the error toast; keep the user in edit mode.
    }
  };

  const hostComponents = getHostComponents();
  const HostModal = hostComponents.Modal;

  const subtitle =
    node.nodeType === "lore"
      ? `${node.lorebookName}${node.tag ? ` · tag:${node.tag}` : node.inferredFamily ? ` · ${node.lorebookCategory} book` : ""}`
      : node.nodeType === "lorebook"
        ? `Lorebook · ${node.entryCount} entries`
        : node.nodeType;

  const actionButtons = (
    <div className="flex flex-wrap items-center gap-1.5">
      {isLore && mode === "read" ? (
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          onClick={() => {
            resetDraftFromNode(node);
            setMode("edit");
          }}
        >
          <Pencil size="0.75rem" />
          Edit entry
        </button>
      ) : null}
      {onOpenLorebook && lorebookId ? (
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          onClick={() => {
            onOpenLorebook(lorebookId, node.nodeType === "lore" ? node.id : undefined);
            onClose();
          }}
        >
          <ExternalLink size="0.75rem" />
          {node.nodeType === "lore" ? "Open in editor" : "Open lorebook"}
        </button>
      ) : null}
      {onOpenCharacter && node.nodeType === "character" ? (
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          onClick={() => {
            onOpenCharacter(node.id);
            onClose();
          }}
        >
          <ExternalLink size="0.75rem" />
          Open character
        </button>
      ) : null}
      {onOpenPersona && node.nodeType === "persona" ? (
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          onClick={() => {
            onOpenPersona(node.id);
            onClose();
          }}
        >
          <ExternalLink size="0.75rem" />
          Open persona
        </button>
      ) : null}
    </div>
  );

  const modalBody =
    isLore && mode === "edit" ? (
      <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-xs">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block font-medium text-[var(--muted-foreground)]">Name</span>
            <input
              type="text"
              disabled={saving}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mari-chrome-field h-8 w-full rounded px-2 text-xs disabled:opacity-60"
            />
          </label>
          <div className="space-y-1">
            <span className="block font-medium text-[var(--muted-foreground)]">Category / Tag</span>
            <div className="flex gap-1.5">
              <LmSelect
                label="Tag preset"
                disabled={saving}
                value={TAG_PRESETS.some((p) => p.value === tag) ? tag : "__custom__"}
                onChange={(nextValue) => {
                  if (nextValue !== "__custom__") setTag(nextValue);
                }}
                className="mari-chrome-field h-8 w-36 rounded px-1.5 text-xs disabled:opacity-60"
                options={[
                  ...TAG_PRESETS,
                  ...(!TAG_PRESETS.some((p) => p.value === tag) ? [{ value: "__custom__", label: "custom" }] : []),
                ]}
              />
              <label htmlFor="lm-entry-custom-tag" className="sr-only">
                Custom tags
              </label>
              <input
                id="lm-entry-custom-tag"
                aria-describedby="lm-entry-tag-hint"
                type="text"
                disabled={saving}
                value={tag}
                placeholder="custom tag…"
                onChange={(event) => setTag(event.target.value)}
                className="mari-chrome-field h-8 min-w-0 flex-1 rounded px-2 text-xs disabled:opacity-60"
              />
            </div>
            <p id="lm-entry-tag-hint" className="text-[0.625rem] text-[var(--muted-foreground)]">
              Comma-separate for multi-tags (e.g. location, faction)
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block font-medium text-[var(--muted-foreground)]">Primary keywords (comma-separated)</span>
            <input
              type="text"
              disabled={saving}
              value={keysText}
              onChange={(event) => setKeysText(event.target.value)}
              className="mari-chrome-field h-8 w-full rounded px-2 text-xs disabled:opacity-60"
            />
          </label>
          <label className="space-y-1">
            <span className="block font-medium text-[var(--muted-foreground)]">
              Secondary keywords (comma-separated)
            </span>
            <input
              type="text"
              disabled={saving}
              value={secondaryKeysText}
              onChange={(event) => setSecondaryKeysText(event.target.value)}
              className="mari-chrome-field h-8 w-full rounded px-2 text-xs disabled:opacity-60"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="block font-medium text-[var(--muted-foreground)]">Description (short summary)</span>
          <textarea
            rows={2}
            disabled={saving}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="mari-chrome-field w-full rounded p-2 text-xs disabled:opacity-60"
          />
        </label>

        <label className="block space-y-1">
          <span className="block font-medium text-[var(--muted-foreground)]">Content</span>
          <textarea
            rows={8}
            disabled={saving}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="mari-chrome-field w-full rounded p-2 text-xs leading-relaxed disabled:opacity-60"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={saving}
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>Enabled</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={saving}
                checked={constant}
                onChange={(event) => setConstant(event.target.checked)}
              />
              <span>Constant</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              className="mari-chrome-control mari-chrome-control--small"
              onClick={() => {
                resetDraftFromNode(node);
                setMode("read");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              className="mari-chrome-control mari-chrome-control--small font-medium"
              onClick={() => void handleSave()}
            >
              <Save size="0.75rem" />
              Save changes
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
        {isLore && (node.keys.length > 0 || node.secondaryKeys.length > 0) ? (
          <div className="space-y-1.5 rounded-lg border border-[var(--border)] p-3 text-xs">
            {node.keys.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="font-medium text-[var(--muted-foreground)]">Keywords:</span>
                {node.keys.map((key) => (
                  <span
                    key={`rk-${key}`}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.6875rem]"
                  >
                    {key}
                  </span>
                ))}
              </div>
            ) : null}
            {node.secondaryKeys.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="font-medium text-[var(--muted-foreground)]">Secondary:</span>
                {node.secondaryKeys.map((key) => (
                  <span
                    key={`rsk-${key}`}
                    className="rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[0.6875rem]"
                  >
                    {key}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {(node.nodeType === "character" || node.nodeType === "persona") && node.aliases.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] p-3 text-xs">
            <span className="font-medium text-[var(--muted-foreground)]">Other names:</span>
            {node.aliases.map((alias) => (
              <span
                key={`ra-${alias}`}
                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.6875rem]"
              >
                {alias}
              </span>
            ))}
          </div>
        ) : null}

        {node.description ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-[var(--muted-foreground)]">Description</div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed">{node.description}</p>
          </div>
        ) : null}

        {isLore ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-[var(--muted-foreground)]">Content</div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{node.content || "(Empty content)"}</p>
          </div>
        ) : null}
      </div>
    );

  if (HostModal) {
    return (
      <HostModal open onClose={onClose} title={node.name} width="max-w-2xl" mobileFullscreen>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
            <span className="text-xs text-[var(--muted-foreground)]">{subtitle}</span>
            {actionButtons}
          </div>
          {modalBody}
        </div>
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
        aria-label={node.name}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-[var(--muted-foreground)]">{subtitle}</div>
            <h2 className="mt-0.5 break-words text-base font-semibold">{node.name}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actionButtons}
            <button
              type="button"
              aria-label="Close"
              className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon"
              onClick={onClose}
            >
              <X size="0.875rem" />
            </button>
          </div>
        </div>
        {modalBody}
      </div>
    </div>,
    document.body,
  );
}
