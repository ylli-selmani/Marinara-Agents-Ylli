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
}

export interface LorebookManagerChatRecord {
  id: string;
  name?: string;
  characterIds: string[];
  personaId: string | null;
}

export interface LorebookManagerRuntimeHost {
  capabilityApi?: { readonly major: number; readonly minor: number };
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
  };
  persistence: {
    documents: LorebookManagerDocumentStore;
    /** Requires `chat-read`. Chats and messages live on persistence, not on resources. */
    listMessages?(chatId: string): Promise<LorebookManagerMessageRecord[]>;
    getChat?(chatId: string): Promise<LorebookManagerChatRecord | null>;
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
