export interface LorebookManagerDocumentRecord {
  id: string;
  packageId: string;
  kind: string;
  name: string;
  description: string;
  data: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LorebookManagerDocumentWrite {
  id: string;
  packageId: string;
  kind: string;
  name: string;
  description: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LorebookManagerDocumentUpdate {
  id: string;
  packageId: string;
  expectedRevision: number;
  name: string;
  description: string;
  data: unknown;
  updatedAt: string;
}

export interface LorebookManagerDocumentStore {
  list(packageId: string, kind: string): Promise<LorebookManagerDocumentRecord[]>;
  getById(packageId: string, id: string): Promise<LorebookManagerDocumentRecord | null>;
  create(input: LorebookManagerDocumentWrite): Promise<LorebookManagerDocumentRecord>;
  update(input: LorebookManagerDocumentUpdate): Promise<LorebookManagerDocumentRecord | null>;
  remove(packageId: string, id: string, expectedRevision: number): Promise<boolean>;
}

export interface LorebookManagerMessageRecord {
  id: string;
  role: string;
  content: string;
  extra: unknown;
  createdAt: string;
  agentContent?: string;
  /** Which swipe of the message is the visible one. */
  activeSwipeIndex?: number;
}

export interface LorebookManagerGameStateRecord {
  messageId: string;
  swipeIndex: number;
  location: string | null;
}

export interface LorebookManagerChatRecord {
  id: string;
  name?: string;
  characterIds: string[];
  personaId: string | null;
  connectionId?: string | null;
  mode?: string;
  /** The chat's metadata: a JSON string or an object (Review Agent Outputs, the agents added to the chat). */
  metadata?: unknown;
}

/** The Engine's `CapabilityDecisionHost` (optional: absent on older Engines). */
export interface LorebookManagerDecisionHost {
  evaluate(request: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    questions: Array<{ id: string; question: string }>;
    signal?: AbortSignal;
  }): Promise<{
    model: string | null;
    answers: Record<string, number>;
    choices: Record<string, string>;
    threshold: number;
  } | null>;
}

/** The Engine's `CapabilityLanguageModelHost`, the part the Librarian uses. */
export interface LorebookManagerLanguageModelHost {
  resolveForRequest(request: { connectionId?: string | null; chatConnectionId?: string | null }): Promise<{
    connectionId: string;
    model: string;
    chatComplete(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
    ): Promise<{ content: string | null; finishReason: string }>;
  }>;
}

/** The Engine's `CapabilityEmbeddingHost`. `embed` answers null (it doesn't throw) when it can't embed. */
export interface LorebookManagerEmbeddingHost {
  spaceId: string;
  label: string;
  embed(texts: string[], signal?: AbortSignal, inputType?: "query" | "document"): Promise<number[][] | null>;
}

export interface LorebookManagerRuntimeHost {
  capabilityApi?: { readonly major: number; readonly minor: number };
  /** The embedding source configured when the package activated. */
  embeddings?: LorebookManagerEmbeddingHost;
  /** Capability API 1.15. The package's current embedding source (its agent connection, else the app default). */
  resolveEmbeddings?(): Promise<LorebookManagerEmbeddingHost>;
  /** The user's Decision model (Stage 2 gate, Decision mode). */
  decisions?: LorebookManagerDecisionHost;
  /** Language models (Stage 2 gate, Librarian mode). */
  languageModels?: LorebookManagerLanguageModelHost;
  json?: { parseJsonish(raw: string): unknown };
  logger: {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(error: unknown, message: string, ...args: unknown[]): void;
  };
  resources: {
    listCharacters(characterIds?: string[]): Promise<Array<{ id: string; data: unknown; comment: string }>>;
    listPersonas(personaIds?: string[]): Promise<Array<{ id: string; data: unknown }>>;
    listLorebooks(lorebookIds?: string[]): Promise<Array<{ id: string; data: unknown; entries: unknown[] }>>;
    /** Capability API 1.839. */
    createLorebookEntry?(
      lorebookId: string,
      entry: Record<string, unknown>,
    ): Promise<{ id: string; lorebookId: string; data: Record<string, unknown> }>;
    /** Capability API 1.839. Refuses a locked entry. */
    updateLorebookEntry?(
      entryId: string,
      patch: Record<string, unknown>,
    ): Promise<{ id: string; lorebookId: string; data: Record<string, unknown> } | null>;
    removeLorebookEntry?(entryId: string): Promise<void>;
  };
  persistence: {
    documents: LorebookManagerDocumentStore;
    /** Requires `chat-read`. Chats and messages live on persistence, not on resources. */
    listMessages?(chatId: string): Promise<LorebookManagerMessageRecord[]>;
    getChat?(chatId: string): Promise<LorebookManagerChatRecord | null>;
    /** Requires `chat-read`. The committed tracker state per message (the active swipe's), World State included. */
    listGameStates?(chatId: string): Promise<LorebookManagerGameStateRecord[]>;
  };
}

let runtime: LorebookManagerRuntimeHost | null = null;
let registration = 0;

export function configureLorebookManagerRuntime(next: LorebookManagerRuntimeHost): () => void {
  const token = ++registration;
  runtime = next;
  return () => {
    if (registration === token) runtime = null;
  };
}

export function getLorebookManagerRuntime(): LorebookManagerRuntimeHost {
  if (!runtime) throw new Error("Lorebook Manager runtime is not configured");
  return runtime;
}
