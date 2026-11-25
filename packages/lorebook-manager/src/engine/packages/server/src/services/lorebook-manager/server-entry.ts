import type { FastifyPluginAsync } from "fastify";
import { configureLorebookManagerRuntime, type LorebookManagerRuntimeHost } from "./package-runtime.js";
import { lorebookManagerRoutes } from "./routes.js";

type ActivationContext = {
  api: {
    runtime: LorebookManagerRuntimeHost;
    registerPrivilegedRoutes(routes: FastifyPluginAsync, options: { prefix: string }): Promise<() => void>;
  };
};

let ready = false;

export async function activate({ api }: ActivationContext) {
  const releases: Array<() => void> = [configureLorebookManagerRuntime(api.runtime)];
  const unwind = () => {
    while (releases.length > 0) releases.pop()!();
  };
  try {
    releases.push(await api.registerPrivilegedRoutes(lorebookManagerRoutes, { prefix: "/api/lorebook-manager" }));
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
}
