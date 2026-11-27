import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const source = readFileSync(
  "packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/useFillHeight.ts",
  "utf8",
);
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
let top = 220;
const header = { previousElementSibling: null };
const documentElement = { parentElement: null, previousElementSibling: null };
const host = { parentElement: documentElement, previousElementSibling: null };
const panel = {
  style: { height: "", minHeight: "" },
  parentElement: host,
  previousElementSibling: header,
  getBoundingClientRect: () => ({ top }),
};
const listeners = new Map<string, () => void>();
const viewport = {
  innerHeight: 900,
  addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
  removeEventListener: (name: string) => listeners.delete(name),
};
let resize: () => void;
let cleanup: (() => void) | undefined;
let disconnected = false;
const observed = new Set();
const module = { exports: {} as { useFillHeight: (options?: { enabled?: boolean }) => unknown } };
runInNewContext(code, {
  module,
  exports: module.exports,
  require: () => ({
    useState: () => [panel, () => {}],
    useLayoutEffect: (effect: () => (() => void) | undefined) => {
      cleanup = effect();
    },
  }),
  window: viewport,
  ResizeObserver: class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe(element: unknown) {
      observed.add(element);
    }
    disconnect() {
      disconnected = true;
    }
  },
});

module.exports.useFillHeight();
assert.equal(panel.style.height, "668px", "fills from the measured top to a 12px bottom margin");
assert.ok(observed.has(header) && observed.has(host) && observed.has(documentElement));

viewport.innerHeight = 1400;
listeners.get("resize")!();
assert.equal(panel.style.height, "1168px", "zoom-out-sized viewports have no upper cap");
top = 360;
resize!();
assert.equal(panel.style.height, "1028px", "header reflow updates the measured top without a window resize");
viewport.innerHeight = 500;
listeners.get("resize")!();
assert.equal(panel.style.height, "320px", "small viewports retain the minimum and can scroll the page");
assert.equal(panel.style.minHeight, "320px");

cleanup!();
assert.equal(listeners.size, 0);
assert.ok(disconnected);
assert.equal(panel.style.height, "");
assert.equal(panel.style.minHeight, "");
module.exports.useFillHeight({ enabled: false });
assert.equal(panel.style.height, "", "fullscreen keeps its own inset-based sizing");
assert.equal(listeners.size, 0);
console.log("lorebook-manager-fill-height.regression: all assertions passed");
