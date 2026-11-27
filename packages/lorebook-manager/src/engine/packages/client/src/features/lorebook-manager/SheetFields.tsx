import { useState } from "react";
import { Check, FileText, RotateCcw } from "lucide-react";
import { ENTITY_FAMILIES, type EntityFamily } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  cardStateFields,
  normalizeSheetOverrides,
  sheetFields,
  type LmSheetOverrides,
} from "../../../../shared/src/features/agents/lorebook-manager/sheets.js";
import { FAMILY_META } from "./LorebookGraph";

export function SheetFields({
  value,
  onChange,
  disabled,
}: {
  value: LmSheetOverrides;
  onChange: (next: LmSheetOverrides) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<EntityFamily>("character");
  const custom = normalizeSheetOverrides(value)[selected] !== undefined;
  const textId = `lm-sheet-${selected}`;
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Sheet family" className="flex flex-wrap items-center gap-1">
        {ENTITY_FAMILIES.filter((family) => family !== "lore").map((family) => (
          <button
            key={family}
            type="button"
            aria-pressed={selected === family}
            onClick={() => setSelected(family)}
            className="mari-chrome-control mari-chrome-control--small"
          >
            {FAMILY_META[family].label}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor={textId} className="block font-semibold text-[var(--foreground)]">
          {FAMILY_META[selected].label} fields
        </label>
        <div className="mb-2 flex items-center gap-2">
          {custom ? (
            <span className="flex items-center gap-1 rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
              <FileText aria-hidden="true" size="0.625rem" /> Custom
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-emerald-400">
              <Check aria-hidden="true" size="0.625rem" /> Using default
            </span>
          )}
          <div className="flex-1" />
          {value[selected] !== undefined ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                const next = { ...value };
                delete next[selected];
                onChange(next);
              }}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-45"
            >
              <RotateCcw aria-hidden="true" size="0.625rem" /> Reset to default
            </button>
          ) : null}
        </div>
        <textarea
          id={textId}
          rows={10}
          disabled={disabled}
          value={sheetFields(selected, value).join("\n")}
          onChange={(event) => onChange({ ...value, [selected]: event.target.value.split("\n") })}
          className="mari-chrome-field w-full rounded px-2.5 py-1.5 text-sm md:text-xs"
        />
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
          One field per line. The Archivist writes new entries as these lines and updates one line at a time. Currently
          is for temporary details.
        </p>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">Lore entries stay free text.</p>
      </div>
      {selected === "character" ? (
        <div className="space-y-1">
          <label htmlFor="lm-sheet-card-state" className="block font-semibold text-[var(--foreground)]">
            Sent while the card is active
          </label>
          <div className="mb-2 flex items-center gap-2">
            {normalizeSheetOverrides(value).cardState !== undefined ? (
              <span className="flex items-center gap-1 rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
                <FileText aria-hidden="true" size="0.625rem" /> Custom
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-emerald-400">
                <Check aria-hidden="true" size="0.625rem" /> Using default
              </span>
            )}
            <div className="flex-1" />
            {value.cardState !== undefined ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const next = { ...value };
                  delete next.cardState;
                  onChange(next);
                }}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-45"
              >
                <RotateCcw aria-hidden="true" size="0.625rem" /> Reset to default
              </button>
            ) : null}
          </div>
          <textarea
            id="lm-sheet-card-state"
            rows={6}
            disabled={disabled}
            value={cardStateFields(value).join("\n")}
            onChange={(event) => onChange({ ...value, cardState: event.target.value.split("\n") })}
            className="mari-chrome-field w-full rounded px-2.5 py-1.5 text-sm md:text-xs"
          />
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            A card's stub entry is sent whole when the character is only mentioned. While the card is active, only these
            lines ride along with it; the card holds the rest. Leave it empty to send nothing then.
          </p>
        </div>
      ) : null}
    </div>
  );
}
