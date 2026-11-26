import { useQuery } from "@tanstack/react-query";
import type {
  LmArchivistMode,
  LmArchivistOverride,
  LmArchivistSettings,
  LmCrawlerSettings,
  LmCrawlerTrigger,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import { fetchTextConnections, lmQueryKeys } from "./api";

// The Archivist's and the Crawler's settings. Precedent: RecallFields in this package (labels, field sizes, the
// Librarian's connection select), so the three Settings tabs read alike.

export const ARCHIVIST_MODE_LABELS: Record<LmArchivistMode, string> = {
  off: "Off",
  suggest: "Suggest (to Review)",
  automatic: "Automatic (to Review for now)",
};

const CRAWLER_TRIGGER_LABELS: Record<LmCrawlerTrigger, string> = {
  after_archivist: "After an Archivist change is applied",
  on_demand: "Only when I run it",
};

function ConnectionSelect({
  value,
  onChange,
  disabled,
  emptyLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  emptyLabel: string;
}) {
  const connectionsQuery = useQuery({
    queryKey: lmQueryKeys.connections,
    queryFn: fetchTextConnections,
    staleTime: 60_000,
  });
  const connections = connectionsQuery.data ?? [];
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[var(--muted-foreground)]">Connection</span>
      <select
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="mari-chrome-field h-8 max-w-[14rem] rounded px-2 text-xs"
      >
        <option value="">{emptyLabel}</option>
        {connections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name}
          </option>
        ))}
        {value && connectionsQuery.data && !connections.some((connection) => connection.id === value) ? (
          <option value={value}>Missing connection</option>
        ) : null}
      </select>
    </label>
  );
}

function NumberInput({
  label,
  title,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5" title={title}>
      <span className="text-[var(--muted-foreground)]">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          // As RecallFields: the typed value as is (so "20" can be typed past min 5); Save clamps it.
          const next = Number(event.target.value);
          if (event.target.value.trim() && Number.isFinite(next)) onChange(Math.round(next));
        }}
        className="mari-chrome-field h-8 w-16 rounded px-2 text-xs tabular-nums"
      />
    </label>
  );
}

function ModeSelect({
  value,
  onChange,
  disabled,
}: {
  value: LmArchivistMode;
  onChange: (value: LmArchivistMode) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[var(--muted-foreground)]">Archivist</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value as LmArchivistMode)}
        className="mari-chrome-field h-8 rounded px-2 text-xs"
      >
        {(Object.keys(ARCHIVIST_MODE_LABELS) as LmArchivistMode[]).map((mode) => (
          <option key={mode} value={mode}>
            {ARCHIVIST_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The Settings tab's Archivist defaults. */
export function ArchivistFields({
  value,
  onChange,
  disabled,
}: {
  value: LmArchivistSettings;
  onChange: <K extends keyof LmArchivistSettings>(key: K, value: LmArchivistSettings[K]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <ModeSelect value={value.mode} onChange={(mode) => onChange("mode", mode)} disabled={disabled} />
        <NumberInput
          label="Every"
          title="Reads the chat after this many replies have settled."
          value={value.everyNTurns}
          min={1}
          max={50}
          disabled={disabled}
          onChange={(next) => onChange("everyNTurns", next)}
        />
        <span className="-ml-1.5 text-[var(--muted-foreground)]">replies</span>
        <NumberInput
          label="Leave unread"
          title="The newest messages it never reads, so a swipe can't write lore."
          value={value.unreadMessages}
          min={1}
          max={10}
          disabled={disabled}
          onChange={(next) => onChange("unreadMessages", next)}
        />
        <ConnectionSelect
          value={value.connectionId}
          onChange={(next) => onChange("connectionId", next)}
          disabled={disabled}
          emptyLabel="Agents' default, then the chat's"
        />
      </div>
      <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
        After every few replies, the Archivist reads what happened and suggests new facts for existing entries and new
        entries for people, places and things that matter. One model call per run, in the background; your replies never
        wait for it. Locked entries are never touched. Suggestions wait in Review. Automatic mode applies them once Undo
        is in; until then it works like Suggest.
      </p>
    </div>
  );
}

/** The Settings tab's Crawler defaults (global only). */
export function CrawlerFields({
  value,
  onChange,
  disabled,
}: {
  value: LmCrawlerSettings;
  onChange: <K extends keyof LmCrawlerSettings>(key: K, value: LmCrawlerSettings[K]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-[var(--muted-foreground)]">Runs</span>
          <select
            disabled={disabled}
            value={value.trigger}
            onChange={(event) => onChange("trigger", event.target.value as LmCrawlerTrigger)}
            className="mari-chrome-field h-8 rounded px-2 text-xs"
          >
            {(Object.keys(CRAWLER_TRIGGER_LABELS) as LmCrawlerTrigger[]).map((trigger) => (
              <option key={trigger} value={trigger}>
                {CRAWLER_TRIGGER_LABELS[trigger]}
              </option>
            ))}
          </select>
        </label>
        <NumberInput
          label="Entries per run"
          title="How many entries one Tidy run sends to the model."
          value={value.batchSize}
          min={5}
          max={50}
          disabled={disabled}
          onChange={(next) => onChange("batchSize", next)}
        />
        <ConnectionSelect
          value={value.connectionId}
          onChange={(next) => onChange("connectionId", next)}
          disabled={disabled}
          emptyLabel="Same as the Archivist"
        />
      </div>
      <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
        The Crawler tidies entries: a short summary, keywords, a tag, and links to the entries and cards they mention.
        It runs on the entries an applied Archivist change touched, or on a whole Compendium from Review (Tidy entries).
        Its suggestions wait in Review too.
      </p>
    </div>
  );
}

/** In a Compendium: the Archivist's mode and interval, each following the default until set here. */
export function ArchivistOverrideFields({
  defaults,
  overrides,
  onChange,
  disabled,
}: {
  defaults: LmArchivistSettings;
  overrides: LmArchivistOverride;
  onChange: (next: LmArchivistOverride) => void;
  disabled?: boolean;
}) {
  const mode = overrides.mode ?? defaults.mode;
  const every = overrides.everyNTurns ?? defaults.everyNTurns;
  const mark = (field: keyof LmArchivistOverride, defaultText: string) =>
    overrides[field] === undefined ? (
      <span
        data-lm-inherit="default"
        title={`Follows the default (${defaultText}). Change it to set this Compendium's own.`}
        className="self-center rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
      >
        Default
      </span>
    ) : (
      <button
        type="button"
        data-lm-inherit="own"
        disabled={disabled}
        onClick={() => {
          const next = { ...overrides };
          delete next[field];
          onChange(next);
        }}
        className="self-center text-[0.625rem] text-[var(--muted-foreground)] underline hover:text-[var(--foreground)] disabled:opacity-50"
      >
        Use default ({defaultText})
      </button>
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeSelect value={mode} onChange={(next) => onChange({ ...overrides, mode: next })} disabled={disabled} />
        {mark("mode", ARCHIVIST_MODE_LABELS[defaults.mode])}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NumberInput
          label="Every"
          value={every}
          min={1}
          max={50}
          disabled={disabled}
          onChange={(next) => onChange({ ...overrides, everyNTurns: next })}
        />
        <span className="-ml-1 text-[var(--muted-foreground)]">replies</span>
        {mark("everyNTurns", String(defaults.everyNTurns))}
      </div>
    </div>
  );
}
