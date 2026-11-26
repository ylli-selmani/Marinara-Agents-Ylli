import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { normalizeStopwordList } from "../../../../shared/src/features/agents/lorebook-manager/retrieval.js";
import type {
  LmBm25Strictness,
  LmRecallSettings,
  LmStage2Gate,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchTextConnections, lmQueryKeys } from "./api";

export type RecallKey = keyof LmRecallSettings;

/** Compendium mode: which fields this Compendium sets itself, and the defaults the rest follow. */
export interface RecallInheritance {
  defaults: LmRecallSettings;
  overridden: ReadonlySet<RecallKey>;
  onUseDefault: (key: RecallKey) => void;
}

export interface RecallFieldsProps {
  /** What the fields show: the defaults (Settings tab) or the Compendium's resolved values. */
  value: LmRecallSettings;
  onChange: <K extends RecallKey>(key: K, value: LmRecallSettings[K]) => void;
  disabled?: boolean;
  inherit?: RecallInheritance;
  /** Shown under meaning match while it is on (the Compendium dialog's Vectorize missing). */
  meaningExtra?: ReactNode;
}

const GATE_LABELS: Record<LmStage2Gate, string> = {
  instant: "Off (fastest)",
  decision: "Decision model",
  librarian: "Librarian (language model)",
};

const STRICTNESS_LABELS: Record<LmBm25Strictness, string> = {
  loose: "Loose (more shared-word hits)",
  normal: "Normal",
  strict: "Strict (only strong hits)",
};

function displayValue(key: RecallKey, settings: LmRecallSettings): string {
  const value = settings[key];
  if (key === "stage2Gate") return GATE_LABELS[value as LmStage2Gate];
  if (key === "bm25Strictness") return STRICTNESS_LABELS[value as LmBm25Strictness].split(" (")[0]!;
  if (key === "librarianConnectionId") return value ? "a connection" : "agents' default";
  if (key === "extraStopwords") {
    const words = value as string[];
    return words.length === 0 ? "none" : `${words.length} word${words.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/**
 * Beside each field in a Compendium: "Default" while it follows the defaults, or a one-click way back to them once
 * the Compendium sets its own (Long-Term Memory's chat settings do the same per field).
 */
function InheritMark({
  field,
  inherit,
  disabled,
}: {
  field: RecallKey;
  inherit?: RecallInheritance;
  disabled?: boolean;
}) {
  if (!inherit) return null;
  const defaultText = displayValue(field, inherit.defaults);
  if (!inherit.overridden.has(field)) {
    return (
      <span
        data-lm-inherit="default"
        title={`Follows the default (${defaultText}). Change it to set this Compendium's own.`}
        className="self-start rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
      >
        Default
      </span>
    );
  }
  return (
    <button
      type="button"
      data-lm-inherit="own"
      disabled={disabled}
      onClick={() => inherit.onUseDefault(field)}
      className="self-start text-[0.625rem] text-[var(--muted-foreground)] underline hover:text-[var(--foreground)] disabled:opacity-50"
    >
      Use default ({defaultText})
    </button>
  );
}

function NumberField({
  field,
  label,
  title,
  min,
  max,
  step = 1,
  width = "w-16",
  props,
}: {
  field: "tokenBudget" | "queryMessageCount" | "maxOneHop" | "maxTextHits" | "semanticThreshold";
  label: string;
  title?: string;
  min: number;
  max: number;
  step?: number;
  width?: string;
  props: RecallFieldsProps;
}) {
  return (
    <div className="flex flex-col gap-1" title={title}>
      <label className="flex items-center gap-1.5">
        <span className="text-[var(--muted-foreground)]">{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={props.disabled}
          value={props.value[field]}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (event.target.value.trim() && Number.isFinite(next)) props.onChange(field, next);
          }}
          className={`mari-chrome-field h-8 ${width} rounded px-2 text-xs tabular-nums`}
        />
      </label>
      <InheritMark field={field} inherit={props.inherit} disabled={props.disabled} />
    </div>
  );
}

/** Words to skip: typed freely, cleaned the way shared-word matching reads words when the field loses focus. */
function StopwordsField({ props }: { props: RecallFieldsProps }) {
  const saved = props.value.extraStopwords.join(", ");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <label className="block space-y-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[var(--muted-foreground)]">Words to skip</span>
        <InheritMark field="extraStopwords" inherit={props.inherit} disabled={props.disabled} />
      </span>
      <textarea
        rows={2}
        disabled={props.disabled}
        value={draft}
        placeholder="e.g. eyes, smiled, looked"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const words = normalizeStopwordList([draft]);
          setDraft(words.join(", "));
          if (words.join(",") !== props.value.extraStopwords.join(",")) props.onChange("extraStopwords", words);
        }}
        className="mari-chrome-field w-full rounded px-2.5 py-1.5 text-sm md:text-xs"
      />
      <span className="block text-[0.6875rem] text-[var(--muted-foreground)]">
        Words that show up everywhere in your chats and pull in unrelated entries. They never count as shared words;
        keywords still match them. Common words like &quot;the&quot; are always skipped.
      </span>
    </label>
  );
}

/**
 * The Recall settings: budgets, matching, meaning match and the loose-match check. The Settings tab shows the
 * defaults; the Compendium dialog shows the same fields with what the Compendium sets itself.
 */
export function RecallFields(props: RecallFieldsProps) {
  const { value, onChange, disabled, inherit } = props;
  const connectionsQuery = useQuery({
    queryKey: lmQueryKeys.connections,
    queryFn: fetchTextConnections,
    enabled: value.stage2Gate === "librarian",
    staleTime: 60_000,
  });
  const connections = connectionsQuery.data ?? [];

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-start gap-3">
        <NumberField field="tokenBudget" label="Token budget" min={100} max={128000} width="w-24" props={props} />
        <NumberField
          field="queryMessageCount"
          label="Messages to match"
          title="Keywords and shared words look at this many of the latest messages (yours and the replies). Meaning match uses your own last messages only, like the Engine's lorebook vectors."
          min={1}
          max={10}
          props={props}
        />
        <NumberField field="maxTextHits" label="Max text hits" min={0} max={25} props={props} />
        <NumberField field="maxOneHop" label="Max 1-hop bonus" min={0} max={20} props={props} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.respectBookBudgets}
            onChange={(event) => onChange("respectBookBudgets", event.target.checked)}
          />
          <span>Respect each lorebook&apos;s own token budget when no override is set</span>
        </label>
        <InheritMark field="respectBookBudgets" inherit={inherit} disabled={disabled} />
      </div>

      <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
            <input
              type="checkbox"
              disabled={disabled}
              checked={value.semanticEnabled}
              onChange={(event) => onChange("semanticEnabled", event.target.checked)}
            />
            <span>Also find entries by meaning, not just keywords (needs an embedding model)</span>
          </label>
          <InheritMark field="semanticEnabled" inherit={inherit} disabled={disabled} />
        </div>
        {value.semanticEnabled ? (
          <div className="flex flex-wrap items-start gap-3">
            <NumberField
              field="semanticThreshold"
              label="Min. similarity"
              title="How close in meaning an entry has to be (0–1). Lower finds more, higher finds less."
              min={0.05}
              max={0.95}
              step={0.05}
              props={props}
            />
            {props.meaningExtra}
          </div>
        ) : null}
        {value.semanticEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <label
              className="flex items-center gap-2 text-[var(--muted-foreground)]"
              title="Also search the recent replies separately and keep the stronger match. Your own messages are searched as they are. This embeds a second text each turn."
            >
              <input
                type="checkbox"
                disabled={disabled}
                checked={value.meaningIncludeReplies}
                onChange={(event) => onChange("meaningIncludeReplies", event.target.checked)}
              />
              <span>Include character context (the replies, searched separately)</span>
            </label>
            <InheritMark field="meaningIncludeReplies" inherit={inherit} disabled={disabled} />
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
        {/* Not under meaning match: shared-word hits are checked too, so the gate helps without embeddings. */}
        <div className="flex flex-wrap items-start gap-3">
          <div
            className="flex flex-col gap-1"
            title="Entries found only by shared words or by meaning can be noise. A check asks a model which ones fit the scene; anything it can't answer stays in."
          >
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">Check loose matches</span>
              <select
                disabled={disabled}
                value={value.stage2Gate}
                onChange={(event) => onChange("stage2Gate", event.target.value as LmStage2Gate)}
                className="mari-chrome-field h-8 rounded px-2 text-xs"
              >
                {(Object.keys(GATE_LABELS) as LmStage2Gate[]).map((gate) => (
                  <option key={gate} value={gate}>
                    {GATE_LABELS[gate]}
                  </option>
                ))}
              </select>
            </label>
            <InheritMark field="stage2Gate" inherit={inherit} disabled={disabled} />
          </div>
          {value.stage2Gate === "librarian" ? (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5">
                <span className="text-[var(--muted-foreground)]">Connection</span>
                <select
                  disabled={disabled}
                  value={value.librarianConnectionId ?? ""}
                  onChange={(event) => onChange("librarianConnectionId", event.target.value || null)}
                  className="mari-chrome-field h-8 max-w-[14rem] rounded px-2 text-xs"
                >
                  <option value="">Agents&apos; default, then the chat&apos;s</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                  {/* A saved connection that has since been deleted stays visible, as in Saucelings' picker. */}
                  {value.librarianConnectionId &&
                  connectionsQuery.data &&
                  !connections.some((connection) => connection.id === value.librarianConnectionId) ? (
                    <option value={value.librarianConnectionId}>Missing connection</option>
                  ) : null}
                </select>
              </label>
              <InheritMark field="librarianConnectionId" inherit={inherit} disabled={disabled} />
            </div>
          ) : null}
          {value.stage2Gate !== "instant" ? (
            <span className="basis-full text-[0.6875rem] text-[var(--muted-foreground)]">
              {value.stage2Gate === "decision"
                ? "Uses the Decision model from Settings. Checks entries found only by shared words or meaning; keyword, constant, location and linked hits are never checked."
                : "One short model call per turn, about 1–2 seconds. Checks entries found only by shared words or meaning; keyword, constant, location and linked hits are never checked."}
            </span>
          ) : null}
        </div>
      </div>

      <details data-lm-recall-wording className="border-t border-[var(--border)] pt-2">
        <summary className="cursor-pointer font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          Matching and wording
        </summary>
        <div className="mt-2 space-y-2.5">
          <StopwordsField props={props} />
          <div className="flex flex-col gap-1">
            <label className="flex flex-wrap items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">Shared-word strictness</span>
              <select
                disabled={disabled}
                value={value.bm25Strictness}
                onChange={(event) => onChange("bm25Strictness", event.target.value as LmBm25Strictness)}
                className="mari-chrome-field h-8 rounded px-2 text-xs"
              >
                {(Object.keys(STRICTNESS_LABELS) as LmBm25Strictness[]).map((level) => (
                  <option key={level} value={level}>
                    {STRICTNESS_LABELS[level]}
                  </option>
                ))}
              </select>
            </label>
            <InheritMark field="bm25Strictness" inherit={inherit} disabled={disabled} />
            <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
              How far an entry found only by shared words has to stand out from the best one to count.
            </span>
          </div>
        </div>
      </details>
    </div>
  );
}
