import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import type { HostSelectProps } from "../packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/host-components";

// Exercise the wrapper without loading React or the Engine host.
type Element = { type: unknown; props: Record<string, unknown>; children: Element[] };
const createElement = (type: unknown, props: Record<string, unknown>, ...children: Element[]): Element => ({
  type,
  props,
  children: children.flat(Infinity) as Element[],
});
const components: { Select?: (props: HostSelectProps) => unknown } = {};
const source = readFileSync(
  "packages/lorebook-manager/src/engine/packages/client/src/features/lorebook-manager/LmSelect.tsx",
  "utf8",
);
const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsxFactory: "createElement" });
const module = { exports: {} as { LmSelect: (props: Record<string, unknown>) => Element } };
new Function("require", "module", "exports", "createElement", code)(
  (name: string) => {
    assert.equal(name, "./host-components");
    return { getHostComponents: () => components };
  },
  module,
  module.exports,
  createElement,
);
const { LmSelect } = module.exports;
const changes: string[] = [];
const props = {
  value: "",
  label: "Test picker",
  className: "mari-chrome-field h-7 text-xs",
  disabled: true,
  id: "test-picker",
  title: "Picker help",
  onChange: (value: string) => changes.push(value),
  options: [
    { value: "", label: "Default" },
    { value: "one", label: "First", group: "Entries", description: "First hint" },
    { value: "two", label: "Second", group: "Entries", disabled: true },
    { value: "three", label: "Third", group: "Cards" },
    { value: "custom", label: "Custom saved value" },
  ],
};

const native = LmSelect(props);
assert.equal(native.type, "select");
for (const key of ["value", "className", "disabled", "id", "title"] as const) {
  assert.equal(native.props[key], props[key]);
}
assert.equal(native.props["aria-label"], props.label);
assert.deepEqual(
  native.children.map((child) => child.type),
  ["option", "optgroup", "optgroup", "option"],
);
assert.equal(native.children[1].props.label, "Entries");
assert.deepEqual(
  native.children[1].children.map((child) => child.props.value),
  ["one", "two"],
);
assert.equal(native.children[1].children[0].props.title, "First hint");
assert.equal(native.children[1].children[1].props.disabled, true);
assert.equal(native.children[3].props.value, "custom");
(native.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "one" } });
assert.deepEqual(changes, ["one"]);

components.Select = () => null;
const hosted = LmSelect(props);
assert.equal(hosted.type, components.Select);
for (const key of ["value", "label", "className", "disabled", "id", "title", "onChange"] as const) {
  assert.equal(hosted.props[key], props[key]);
}
const hostedOptions = hosted.props.options as HostSelectProps["options"];
assert.equal(hostedOptions[0].value, "", "An empty value remains a selectable default");
assert.equal(hostedOptions[1].group, "Entries");
assert.equal(hostedOptions[1].description, "First hint");
assert.equal(hostedOptions[1].disabledReason, undefined);
assert.equal(hostedOptions[2].disabledReason, "Not available");
assert.equal(hostedOptions[4].label, "Custom saved value");
(hosted.props.onChange as (value: string) => void)("two");
assert.deepEqual(changes, ["one", "two"]);

console.log("lorebook-manager-select.regression: all assertions passed");
