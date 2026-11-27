import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

// Exercise the component with controlled query results and pending host requests, without a server.
const source = readFileSync(
  "packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/ArchivistActivity.tsx",
  "utf8",
);
const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsx: "automatic" });
type Element = { type: string; props: { children?: unknown; disabled?: boolean; onClick?: () => void } };
type Job = { startedAt: string; windowsDone: number; status: string; detail?: string };
const hooks: unknown[] = [];
let hookIndex = 0;
let queryIndex = 0;
let queryOptions: { refetchInterval: (query: unknown) => number };
let job: Job | null = { startedAt: "job1", windowsDone: 0, status: "running" };
let queryError = false;
let olderUnread = 12;
const invalidations: unknown[] = [];
const busy = new Map<string, boolean>();
const queryClient = {
  invalidateQueries: (key: unknown) => invalidations.push(key),
  setQueryData() {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const confirmation = deferred<boolean>();
let request = deferred<{ job: Job | null }>();
const run = deferred<{ status: string }>();
let requests = 0;
const module = { exports: {} as { ArchivistActivity: (props: { chatId: string; showBackfill: boolean }) => unknown } };
runInNewContext(code, {
  module,
  exports: module.exports,
  __MARINARA_HOST__: {
    stores: {
      agent: {
        getState: () => ({
          setPackageActivity: (_id: string, chatId: string, status: { busy: boolean }) => busy.set(chatId, status.busy),
        }),
      },
    },
  },
  require(name: string) {
    if (name === "react")
      return {
        useState(initial: unknown) {
          const index = hookIndex++;
          if (!(index in hooks)) hooks[index] = initial;
          return [
            hooks[index],
            (value: unknown) => {
              hooks[index] = value;
            },
          ];
        },
        useRef(initial: unknown) {
          const index = hookIndex++;
          if (!(index in hooks)) hooks[index] = { current: initial };
          return hooks[index];
        },
        useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
          const index = hookIndex++;
          const previous = hooks[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
          if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        },
      };
    if (name === "react/jsx-runtime")
      return {
        jsx: (type: string, props: Element["props"]) => ({ type, props }),
        jsxs: (type: string, props: Element["props"]) => ({ type, props }),
      };
    if (name === "@tanstack/react-query")
      return {
        useQueryClient: () => queryClient,
        useQuery(options: typeof queryOptions) {
          if (++queryIndex !== 3) return { data: [] };
          queryOptions = options;
          return { data: { olderUnread, windowsEstimated: 1, job }, isError: queryError, refetch() {} };
        },
      };
    if (name === "./api")
      return {
        lmQueryKeys: {
          archivistRuns: ["runs"],
          proposalsRoot: ["proposals"],
          graphRoot: ["graph"],
          archivistBackfill: (id: string) => [id],
        },
        runArchivistApi: () => run.promise,
        changeArchivistBackfill: () => {
          requests++;
          return request.promise;
        },
      };
    if (name === "./host-components") return { confirmWithHostOrBrowser: () => confirmation.promise };
    if (name === "sonner") return { toast: Object.assign(() => {}, { success() {}, error() {} }) };
    if (name === "lucide-react") return { Loader2: "spinner" };
    throw new Error(`Unexpected import: ${name}`);
  },
});
function render(chatId = "chat1") {
  hookIndex = 0;
  queryIndex = 0;
  return module.exports.ArchivistActivity({ chatId, showBackfill: true });
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function button(tree: unknown, label: string) {
  return elements(tree).find((element) => element.type === "button" && text(element) === label)!;
}
async function main() {
  let tree = render();
  assert.equal(invalidations.length, 0, "mount does not invalidate");
  assert.equal(busy.get("chat1"), true);
  assert.equal(queryOptions!.refetchInterval({ state: { status: "success", data: { job } } }), 2_000);
  assert.equal(queryOptions!.refetchInterval({ state: { status: "error", data: { job } } }), 15_000);
  queryError = true;
  tree = render();
  assert.equal(busy.get("chat1"), false, "stale running data cannot keep the icon busy on error");
  assert.ok(text(tree).includes("Could not load Backfill status"));
  queryError = false;
  render();
  assert.equal(invalidations.length, 0, "recovery establishes a baseline");
  job = { ...job!, windowsDone: 1 };
  render();
  assert.equal(invalidations.length, 3, "progress invalidates related data");
  render();
  assert.equal(invalidations.length, 3, "identical polling data does not invalidate");
  render("chat2");
  job = { ...job!, startedAt: "job2" };
  render("chat2");
  assert.equal(invalidations.length, 3, "chat switches and job starts do not invalidate");
  job = { ...job, status: "done", detail: "" };
  tree = render("chat2");
  assert.equal(invalidations.length, 6, "completion invalidates");
  assert.ok(text(tree).includes("Backfill done · 12 older messages"));
  olderUnread = 0;
  tree = render("chat2");
  assert.ok(
    elements(tree).some((element) => element.type === "span" && text(element) === "Backfill done"),
    "empty detail shows only the status when history is complete",
  );
  olderUnread = 12;
  job = { ...job, status: "failed" };
  tree = render("chat2");
  assert.ok(text(tree).includes("Backfill failed · 12 older messages"));
  button(tree, "Backfill unprocessed").props.onClick!();
  tree = render("chat2");
  assert.equal(button(tree, "Backfill unprocessed").props.disabled, true, "disabled during confirmation");
  assert.equal(requests, 0);
  confirmation.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  tree = render("chat2");
  assert.equal(requests, 1);
  assert.equal(button(tree, "Backfill unprocessed").props.disabled, true, "disabled during request");
  request.resolve({ job });
  await new Promise<void>((resolve) => setImmediate(resolve));
  tree = render("chat2");
  assert.equal(button(tree, "Backfill unprocessed").props.disabled, false);
  job = { ...job!, status: "running" };
  request = deferred<{ job: Job | null }>();
  tree = render("chat2");
  button(tree, "Stop").props.onClick!();
  tree = render("chat2");
  assert.equal(button(tree, "Stop").props.disabled, true, "Stop is disabled during its request");
  assert.equal(requests, 2);
  job = { ...job, status: "stopped" };
  request.resolve({ job });
  await new Promise<void>((resolve) => setImmediate(resolve));
  tree = render("chat2");
  button(tree, "Run now").props.onClick!();
  render("chat2");
  assert.equal(busy.get("chat2"), true);
  tree = render("chat3");
  assert.equal(busy.get("chat2"), true, "Run now stays attached to the initiating chat");
  assert.notEqual(busy.get("chat3"), true);
  assert.ok(!elements(tree).some((element) => element.type === "spinner"));
  run.resolve({ status: "nothing_new" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  render("chat3");
  assert.equal(busy.get("chat2"), false);
}
main()
  .then(() => console.log("lorebook-manager-archivist-activity.regression: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
