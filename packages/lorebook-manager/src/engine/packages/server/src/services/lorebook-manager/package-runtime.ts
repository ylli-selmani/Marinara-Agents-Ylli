export interface LorebookManagerRuntimeHost {
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
