import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eraser, Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import {
  diffRecallSettings,
  normalizeRecallSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/settings-helpers.js";
import type {
  LmCompendium,
  LmRecallSettings,
  LmSettings,
} from "../../../../shared/src/features/agents/lorebook-manager/schema.js";
import {
  clearLiveRunsApi,
  fetchSettings,
  indexSemanticApi,
  lmQueryKeys,
  resetSettingsApi,
  saveSettingsApi,
} from "./api";
import { confirmWithHostOrBrowser } from "./host-components";
import { RecallFields } from "./RecallFields";

type SettingsTab = "recall" | "troubleshooting";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "recall", label: "Recall" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

export interface SettingsPanelProps {
  compendiums: readonly LmCompendium[];
}

/**
 * The settings hub, after Long-Term Memory's Memory Settings: the defaults every Compendium uses unless it sets its
 * own, one Save for the whole page, and the maintenance actions. The Archivist and Crawler tabs join with them.
 */
export function SettingsPanel({ compendiums }: SettingsPanelProps) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: lmQueryKeys.settings, queryFn: fetchSettings });
  const saved = settingsQuery.data ?? null;
  const [tab, setTab] = useState<SettingsTab>("recall");
  const [draft, setDraft] = useState<LmRecallSettings | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | "index" | "clear" | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = Boolean(saved && draft && Object.keys(diffRecallSettings(saved.recall, draft)).length > 0);
  // Follow the server while nothing is edited (first load, a save, a reset, a refetch).
  useEffect(() => {
    if (saved && !dirty) setDraft(saved.recall);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const customCount = useMemo(
    () => compendiums.filter((compendium) => Object.keys(compendium.overrides?.recall ?? {}).length > 0).length,
    [compendiums],
  );
  const compendiumBookIds = useMemo(
    () => [...new Set(compendiums.flatMap((compendium) => compendium.lorebookIds))],
    [compendiums],
  );

  const applySaved = (next: LmSettings) => {
    queryClient.setQueryData(lmQueryKeys.settings, next);
    setDraft(next.recall);
    // Every Compendium that follows a default now resolves to the new value.
    void queryClient.invalidateQueries({ queryKey: lmQueryKeys.compendiums });
  };

  const save = async () => {
    if (!saved || !draft || !dirty || busy) return;
    setBusy("save");
    try {
      applySaved(await saveSettingsApi({ recall: normalizeRecallSettings(draft), expectedRevision: saved.revision }));
      setJustSaved(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the settings");
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!saved || busy) return;
    const confirmed = await confirmWithHostOrBrowser({
      title: "Reset to defaults?",
      message:
        "Every setting on this page goes back to how Lorebook Manager ships. Compendiums keep what they set themselves.",
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy("reset");
    try {
      applySaved(await resetSettingsApi(saved.revision));
      setJustSaved(false);
      toast.success("Settings are back to the defaults");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset the settings");
    } finally {
      setBusy(null);
    }
  };

  const vectorizeAll = async () => {
    if (busy || compendiumBookIds.length === 0) return;
    setBusy("index");
    try {
      const status = await indexSemanticApi(compendiumBookIds);
      if (status.failed > 0) toast.error(`${status.failed} entries could not be vectorized. Check the server log.`);
      else
        toast.success(
          status.embedded > 0 ? `Vectorized ${status.embedded} entries` : "Every entry is already vectorized",
        );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not vectorize the lorebooks");
    } finally {
      setBusy(null);
    }
  };

  const clearActivity = async () => {
    if (busy) return;
    const confirmed = await confirmWithHostOrBrowser({
      title: "Clear Activity?",
      message: "Forgets the recorded turns of every chat. Lorebooks, Compendiums and settings stay as they are.",
      confirmLabel: "Clear",
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy("clear");
    try {
      const cleared = await clearLiveRunsApi();
      void queryClient.invalidateQueries({ queryKey: lmQueryKeys.runs });
      toast.success(
        cleared > 0
          ? `Cleared the Activity of ${cleared} chat${cleared === 1 ? "" : "s"}`
          : "Activity was already empty",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear Activity");
    } finally {
      setBusy(null);
    }
  };

  if (settingsQuery.error) {
    return (
      <div role="alert" className="rounded-lg border border-[var(--destructive)]/40 p-4 text-sm">
        {settingsQuery.error instanceof Error ? settingsQuery.error.message : "Could not load the settings"}
      </div>
    );
  }
  if (!saved || !draft) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-[var(--muted-foreground)]">
        <Loader2 aria-hidden="true" size="0.875rem" className="animate-spin" />
        Loading settings…
      </div>
    );
  }

  const stateWord = dirty ? "Unsaved changes" : justSaved ? "Saved" : "No changes";

  return (
    <section
      aria-labelledby="lm-settings-title"
      data-lm-surface="settings"
      className="space-y-3 pr-1 text-xs"
      style={{ maxHeight: "clamp(20rem, calc(100vh - 15rem), 46rem)", overflowY: "auto" }}
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2 py-1 ${dirty ? "sticky top-0 z-10 bg-[var(--background)]" : ""}`}
      >
        <h2 id="lm-settings-title" className="text-sm font-semibold">
          Settings
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* One save model for the page, as in Memory Settings: the state word, Save always there, Discard once edited. */}
          <span
            role="status"
            data-lm-save-state={dirty ? "dirty" : justSaved ? "saved" : "clean"}
            className={`text-xs font-semibold ${dirty ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}`}
          >
            {stateWord}
          </span>
          <button
            type="button"
            aria-disabled={!dirty || busy !== null}
            onClick={() => void save()}
            className="mari-chrome-control mari-chrome-control--small font-medium aria-disabled:opacity-50"
          >
            {busy === "save" ? (
              <Loader2 aria-hidden="true" size="0.75rem" className="animate-spin" />
            ) : (
              <Save aria-hidden="true" size="0.75rem" />
            )}
            Save settings
          </button>
          {dirty ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setDraft(saved.recall);
                setJustSaved(false);
              }}
              className="mari-chrome-control mari-chrome-control--small text-[var(--destructive)]"
            >
              Discard changes
            </button>
          ) : null}
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex w-fit items-center gap-1 rounded-lg border border-[var(--border)] p-0.5"
      >
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            id={`lm-settings-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-pressed={tab === item.id}
            aria-controls={`lm-settings-panel-${item.id}`}
            onClick={() => setTab(item.id)}
            className="mari-chrome-control mari-chrome-control--small"
          >
            {item.label}
            {item.id === "recall" && dirty ? (
              <>
                <span aria-hidden="true" className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
                <span className="sr-only"> (unsaved changes)</span>
              </>
            ) : null}
          </button>
        ))}
      </div>

      <p data-lm-settings-reassurance className="text-[var(--muted-foreground)]">
        Used by every Compendium unless it sets its own
        {customCount === 1
          ? " (1 Compendium sets some of its own; edit it in that Compendium)"
          : customCount > 1
            ? ` (${customCount} Compendiums set some of their own; edit them in each Compendium)`
            : ""}
        .{" "}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void reset()}
          className="inline-flex min-h-8 items-center underline hover:text-[var(--foreground)]"
        >
          Reset to defaults
        </button>
      </p>

      <div
        id="lm-settings-panel-recall"
        role="tabpanel"
        aria-labelledby="lm-settings-tab-recall"
        hidden={tab !== "recall"}
        className="rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-3"
      >
        <RecallFields
          value={draft}
          disabled={busy !== null}
          onChange={(key, value) => {
            setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
            setJustSaved(false);
          }}
        />
      </div>

      <div
        id="lm-settings-panel-troubleshooting"
        role="tabpanel"
        aria-labelledby="lm-settings-tab-troubleshooting"
        hidden={tab !== "troubleshooting"}
        className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-3"
      >
        <div className="space-y-1">
          <button
            type="button"
            disabled={busy !== null || compendiumBookIds.length === 0}
            onClick={() => void vectorizeAll()}
            className="mari-chrome-control mari-chrome-control--small disabled:opacity-45"
          >
            {busy === "index" ? (
              <Loader2 aria-hidden="true" size="0.75rem" className="animate-spin" />
            ) : (
              <Sparkles aria-hidden="true" size="0.75rem" />
            )}
            Vectorize missing
          </button>
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            Embeds every entry in your Compendiums&apos; lorebooks that has no vector yet, for meaning match. Missing
            vectors also fill in by themselves after the first turns.
          </p>
        </div>
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void clearActivity()}
            className="mari-chrome-control mari-chrome-control--small"
          >
            {busy === "clear" ? (
              <Loader2 aria-hidden="true" size="0.75rem" className="animate-spin" />
            ) : (
              <Eraser aria-hidden="true" size="0.75rem" />
            )}
            Clear Activity
          </button>
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            Forgets the recorded turns in the Activity tab, for every chat.
          </p>
        </div>
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void reset()}
            className="mari-chrome-control mari-chrome-control--small text-[var(--destructive)]"
          >
            <RotateCcw aria-hidden="true" size="0.75rem" />
            Reset to defaults
          </button>
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            Puts every setting here back to how Lorebook Manager ships. Compendiums keep what they set themselves.
          </p>
        </div>
      </div>
    </section>
  );
}
