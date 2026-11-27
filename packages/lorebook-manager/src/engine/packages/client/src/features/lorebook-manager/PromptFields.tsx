import { useState } from "react";
import { Check, FileText, RotateCcw } from "lucide-react";
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

const TOOLBAR_BUTTON =
  "flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-45";
const PROMPT_BOX =
  "w-full rounded-xl bg-[var(--secondary)] px-4 py-3 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)]";

/** Same rough estimate the package uses for entries (about four characters per token). */
function estimatedTokens(text: string): string {
  return `~${Math.max(0, Math.ceil(text.length / 4)).toLocaleString()} tokens`;
}

/**
 * Settings → Prompts, after the Engine's agent editor Prompt Template (AgentEditor.tsx): one prompt at a time, the
 * built-in text shown read-only until "Copy default to edit", a Custom override with Reset to default, and the fixed
 * answer format below so it's clear what can't change. Edits are saved with the page's Save settings.
 */
export function PromptFields({ value, onChange, disabled }: PromptFieldsProps) {
  const [selected, setSelected] = useState<LmPromptKey>("tidy");
  const edits = normalizePromptOverrides(value);
  const definition = promptDefinition(selected);
  // A copied or cleared box is a draft too: it shows as Custom override until it's reset or left empty.
  const drafted = value[selected] !== undefined;
  const text = value[selected] ?? definition.instructions;
  const missing = definition.variables.filter(
    (variable) => edits[selected] !== undefined && !text.includes(`{{${variable.name}}}`),
  );
  const textId = `lm-prompt-${selected}`;
  const clearDraft = () => {
    const next = { ...value };
    delete next[selected];
    onChange(next);
  };
  const footer = (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-[0.625rem] text-[var(--muted-foreground)]">
        Leave empty to use the built-in default prompt. Edit to override with your own instructions.
      </p>
      <p className="ml-auto shrink-0 text-right text-[0.625rem] text-[var(--muted-foreground)]">
        {estimatedTokens(text)}
      </p>
    </div>
  );

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
        <label htmlFor={textId} className="block font-semibold text-[var(--foreground)]">
          {definition.label} instructions
        </label>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{definition.description}</p>
        <div className="mb-2 flex items-center gap-2">
          {drafted ? (
            <span className="flex items-center gap-1 rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
              <FileText aria-hidden="true" size="0.625rem" /> Custom override
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-emerald-400">
              <Check aria-hidden="true" size="0.625rem" /> Using built-in default
            </span>
          )}
          <div className="flex-1" />
          {drafted ? (
            <button type="button" disabled={disabled} onClick={clearDraft} className={TOOLBAR_BUTTON}>
              <RotateCcw aria-hidden="true" size="0.625rem" /> Reset to default
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, [selected]: definition.instructions })}
              className={TOOLBAR_BUTTON}
            >
              <FileText aria-hidden="true" size="0.625rem" /> Copy default to edit
            </button>
          )}
        </div>
        {drafted ? (
          <div>
            <textarea
              id={textId}
              rows={16}
              disabled={disabled}
              maxLength={LM_PROMPT_MAX_CHARS}
              value={text}
              onChange={(event) => onChange({ ...value, [selected]: event.target.value })}
              onBlur={() => {
                if (!value[selected]?.trim()) clearDraft();
              }}
              className={`${PROMPT_BOX} max-h-[60vh] resize-y overflow-y-auto placeholder:text-[var(--muted-foreground)]/50 focus:ring-2 focus:ring-[var(--ring)] focus:outline-none`}
            />
            {footer}
          </div>
        ) : (
          <div className="relative">
            <pre
              id={textId}
              className={`${PROMPT_BOX} max-h-[50vh] resize-y overflow-y-auto whitespace-pre-wrap text-[var(--muted-foreground)]`}
            >
              {definition.instructions}
            </pre>
            {footer}
            <span className="absolute top-2 right-3 rounded-md bg-[var(--card)] px-1.5 py-0.5 text-[0.5625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              Default — click &quot;Copy default to edit&quot; to customize
            </span>
          </div>
        )}
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
