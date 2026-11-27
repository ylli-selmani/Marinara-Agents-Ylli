import { useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  LM_PROMPT_MAX_CHARS,
  LM_PROMPTS,
  normalizePromptOverrides,
  promptDefinition,
} from "../../../../shared/src/features/agents/lorebook-manager/prompts.js";
import type { LmPromptKey, LmPromptOverrides } from "../../../../shared/src/features/agents/lorebook-manager/schema.js";

export interface PromptFieldsProps {
  value: LmPromptOverrides;
  onChange: (next: LmPromptOverrides) => void;
  disabled?: boolean;
}

/**
 * Settings → Prompts, after Long-Term Memory's extraction prompt editor: one prompt at a time, its instructions in a
 * text box, Reset to built-in, and the fixed answer format shown below so it's clear what can't change. Edits are
 * saved with the page's Save settings.
 */
export function PromptFields({ value, onChange, disabled }: PromptFieldsProps) {
  const [selected, setSelected] = useState<LmPromptKey>("tidy");
  const edits = normalizePromptOverrides(value);
  const definition = promptDefinition(selected);
  const edited = edits[selected] !== undefined;
  const text = value[selected] ?? definition.instructions;
  const missing = definition.variables.filter((variable) => edited && !text.includes(`{{${variable.name}}}`));
  const textId = `lm-prompt-${selected}`;

  return (
    <div className="space-y-3">
      <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
        The instructions each model call starts with. Edit one to tune it; the answer format at the end stays fixed, so
        the package can always read the answer. Edits are saved with Save settings.
      </p>
      <div role="group" aria-label="Prompt" className="flex flex-wrap items-center gap-1">
        {LM_PROMPTS.map((prompt) => (
          <button
            key={prompt.key}
            type="button"
            aria-pressed={selected === prompt.key}
            onClick={() => setSelected(prompt.key)}
            className="mari-chrome-control mari-chrome-control--small"
          >
            {prompt.label}
            {edits[prompt.key] !== undefined ? (
              <>
                <span aria-hidden="true" className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
                <span className="sr-only"> (edited)</span>
              </>
            ) : null}
          </button>
        ))}
      </div>

      <div className="space-y-1" data-lm-prompt={selected}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={textId} className="font-semibold text-[var(--foreground)]">
            {definition.label} instructions{" "}
            <span className="font-normal text-[var(--muted-foreground)]">{edited ? "(edited)" : "(built-in)"}</span>
          </label>
          <button
            type="button"
            disabled={disabled || !edited}
            onClick={() => {
              const next = { ...value };
              delete next[selected];
              onChange(next);
            }}
            className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
          >
            <RotateCcw aria-hidden="true" size="0.75rem" />
            Reset to built-in
          </button>
        </div>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{definition.description}</p>
        <textarea
          id={textId}
          rows={16}
          disabled={disabled}
          maxLength={LM_PROMPT_MAX_CHARS}
          value={text}
          onChange={(event) => onChange({ ...value, [selected]: event.target.value })}
          className="mari-chrome-field min-h-48 w-full rounded px-2.5 py-2 text-sm md:text-xs"
        />
        {definition.variables.length > 0 ? (
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            {definition.variables.map((variable) => (
              <span key={variable.name} className="block">
                <code>{`{{${variable.name}}}`}</code> becomes {variable.description}.
              </span>
            ))}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <p role="status" className="text-[0.6875rem] text-[var(--destructive)]">
            {missing.map((variable) => `{{${variable.name}}}`).join(", ")} is missing, so the model won&apos;t see{" "}
            {missing.map((variable) => variable.description).join(" or ")}.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <span className="block text-[var(--muted-foreground)]">
          Answer format (fixed, added after the instructions)
        </span>
        <pre className="whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--background)]/40 p-2 text-[0.6875rem] text-[var(--muted-foreground)]">
          {definition.format}
        </pre>
      </div>
    </div>
  );
}
