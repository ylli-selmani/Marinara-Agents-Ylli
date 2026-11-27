import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  LmCompendium,
  LmEntityNode,
  LmGraphPayload,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { createStubApi, lmQueryKeys } from "./api";
import { getHostComponents } from "./host-components";
import { LmSelect } from "./LmSelect";

export function StubEntryModal({
  compendium,
  card,
  payload,
  onClose,
  onCreated,
  onLorebooksChanged,
}: {
  compendium: LmCompendium;
  card: LmEntityNode;
  payload: LmGraphPayload;
  onClose: () => void;
  onCreated: (ref: string) => void;
  onLorebooksChanged?: () => Promise<void>;
}) {
  const books = compendium.lorebookIds.flatMap((id) => payload.lorebooks.filter((book) => book.id === id));
  const [lorebookId, setLorebookId] = useState(() => {
    const categorized = books.find((book) => ["character", "npc"].includes(book.category.trim().toLowerCase()));
    if (categorized) return categorized.id;
    const count = (id: string) =>
      payload.nodes.filter(
        (node) =>
          node.nodeType === "lore" &&
          node.lorebookId === id &&
          (node.family === "character" ||
            node.inferredFamily === "character" ||
            node.secondaryFamilies.includes("character")),
      ).length;
    return [...books].sort((a, b) => count(b.id) - count(a.id))[0]?.id ?? "";
  });
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const queryClient = useQueryClient();
  const HostModal = getHostComponents().Modal;
  const fallbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (HostModal) return;
    const previous = document.activeElement as HTMLElement | null;
    fallbackRef.current?.focus();
    return () => previous?.focus();
  }, [HostModal]);
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const create = async () => {
    if (inFlight.current || !lorebookId) return;
    inFlight.current = true;
    setSaving(true);
    let id: string;
    try {
      id = await createStubApi({ compendiumId: compendium.id, characterId: card.id, lorebookId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create stub entry");
      inFlight.current = false;
      setSaving(false);
      return;
    }
    try {
      await onLorebooksChanged?.();
    } catch {
      toast.error("Saved, but Marinara Engine couldn't refresh its lorebook list.");
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: lmQueryKeys.graphRoot }),
      queryClient.invalidateQueries({ queryKey: lmQueryKeys.crawlerPending(compendium.id) }),
      queryClient.invalidateQueries({ queryKey: ["lorebook-manager", "crawler-untidied"] }),
    ]);
    onCreated(`lore:${id}`);
    onClose();
  };
  const title = `Create stub entry for ${card.name}`;
  const content = (
    <div className="space-y-3" data-lm-stub-modal>
      <LmSelect
        label="Lorebook"
        value={lorebookId}
        options={books.map((book) => ({ value: book.id, label: book.name }))}
        onChange={setLorebookId}
        disabled={saving}
        className="mari-chrome-field w-full rounded px-2 py-1 text-sm"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          disabled={saving}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          disabled={saving || !lorebookId}
          onClick={() => void create()}
        >
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
  if (HostModal)
    return (
      <HostModal open onClose={close} title={title} width="max-w-md">
        {content}
      </HostModal>
    );
  return createPortal(
    <div
      style={{ zIndex: 1100 }}
      className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={fallbackRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const controls = [
              ...(fallbackRef.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), select:not(:disabled), [tabindex='0']",
              ) ?? []),
            ];
            const first = controls[0];
            const last = controls.at(-1);
            if (!first) event.preventDefault();
            else if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === fallbackRef.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {content}
      </div>
    </div>,
    document.body,
  );
}
