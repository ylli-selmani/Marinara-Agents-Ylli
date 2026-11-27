import type { FastifyPluginAsync } from "fastify";
import { claimLorebooksForChat, refreshLiveClaims, resetLiveClaims } from "./live-claims.js";
import { resumeArchivist, stopArchivist } from "./archivist.js";
import { contributeLiveLore, type LivePromptContextRequest } from "./live-retrieval.js";
import { configureLorebookManagerRuntime, type LorebookManagerRuntimeHost } from "./package-runtime.js";
import { lorebookManagerRoutes, setLiveRetrievalRegistered } from "./routes.js";
import { LIVE_CONTRIBUTOR_TIMEOUT_MS } from "./stage2-gate.js";

type ActivationContext = {
  api: {
    runtime: LorebookManagerRuntimeHost;
    registerPrivilegedRoutes(routes: FastifyPluginAsync, options: { prefix: string }): Promise<() => void>;
    registerPromptContext?(
      contributor: (request: LivePromptContextRequest) => Promise<string | null>,
      options?: { timeoutMs?: number },
    ): () => void;
    /** Capability API 1.839. */
    registerLorebookClaims?(
      resolver: (request: { chatId: string; chatMeta?: Record<string, unknown> }) => readonly string[] | null,
    ): () => void;
  };
};

let ready = false;

/**
 * Live retrieval needs lorebook claims (Capability API 1.839): without them the Engine would inject the bound
 * Compendium's books a second time. On older Engines it stays off; the graph, Simulate and Compendiums still work.
 */
async function registerLiveRetrieval(api: ActivationContext["api"], releases: Array<() => void>) {
  if (typeof api.registerLorebookClaims !== "function" || typeof api.registerPromptContext !== "function") {
    api.runtime.logger.info("[lorebook-manager] Live retrieval needs Capability API 1.839; it stays off");
    return;
  }
  releases.push(api.registerLorebookClaims(claimLorebooksForChat));
  // 5 s (the Engine's cap) so a Stage 2 gate has room; the gate keeps its own shorter deadline, and an Instant
  // Compendium still answers in milliseconds.
  releases.push(api.registerPromptContext(contributeLiveLore, { timeoutMs: LIVE_CONTRIBUTOR_TIMEOUT_MS }));
  setLiveRetrievalRegistered(true);
  releases.push(() => setLiveRetrievalRegistered(false));
}

export async function activate({ api }: ActivationContext) {
  const releases: Array<() => void> = [configureLorebookManagerRuntime(api.runtime)];
  const unwind = () => {
    while (releases.length > 0) releases.pop()!();
  };
  resumeArchivist();
  releases.push(() => void stopArchivist());
  releases.push(resetLiveClaims);
  try {
    try {
      // Run now and Backfill also need bindings on Engines without live retrieval.
      await refreshLiveClaims();
    } catch (error) {
      // Start with no bindings rather than fail activation; the next binding write fills the cache.
      api.runtime.logger.error(error, "[lorebook-manager] Could not load chat bindings for live retrieval");
    }
    releases.push(await api.registerPrivilegedRoutes(lorebookManagerRoutes, { prefix: "/api/lorebook-manager" }));
    await registerLiveRetrieval(api, releases);
    ready = true;
    return () => {
      ready = false;
      unwind();
    };
  } catch (error) {
    unwind();
    throw error;
  }
}

export async function selfCheck({ api }: ActivationContext) {
  if (!ready) throw new Error("Lorebook Manager did not initialize");
  if (typeof api.runtime.resources?.listLorebooks !== "function") {
    throw new Error("Lorebook Manager requires resources.listLorebooks");
  }
  if (typeof api.runtime.resources?.listCharacters !== "function") {
    throw new Error("Lorebook Manager requires resources.listCharacters");
  }
  if (typeof api.runtime.resources?.listPersonas !== "function") {
    throw new Error("Lorebook Manager requires resources.listPersonas");
  }
  if (typeof api.runtime.persistence?.documents?.list !== "function") {
    throw new Error("Lorebook Manager requires persistence.documents.list");
  }
}
