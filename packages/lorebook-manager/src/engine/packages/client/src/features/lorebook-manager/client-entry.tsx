import React, { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "marinara:host";
import { LorebookManagerDetail } from "./LorebookManagerDetail";
import type { CapabilityElement } from "./types";

queryClient.setQueryDefaults(["lorebook-manager"], { retry: false, staleTime: 0 });

class LorebookManagerErrorBoundary extends React.Component<
  { element: CapabilityElement; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    const message = error.message || "Lorebook Manager encountered an error";
    this.props.element.capabilityRuntimeError = message;
    this.props.element.dispatchEvent(
      new CustomEvent("marinara-capability-runtime-error", {
        detail: { message },
        bubbles: true,
      }),
    );
    console.error("Lorebook Manager client capability stopped", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mari-editor-panel m-4 space-y-3 p-4 text-sm">
        <p className="font-semibold">{this.state.error.message || "Lorebook Manager stopped unexpectedly."}</p>
        <button
          type="button"
          className="mari-chrome-control mari-chrome-control--small"
          onClick={() => {
            this.props.element.capabilityRuntimeError = null;
            this.setState({ error: null });
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}

function CapabilityRoot({ element }: { element: CapabilityElement }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const update = () => redraw((value) => value + 1);
    element.addEventListener("marinara-capability-props", update);
    return () => element.removeEventListener("marinara-capability-props", update);
  }, [element]);

  const props = element.capabilityProps ?? {};
  const view = element.getAttribute("view");
  if (view !== "detail") return null;

  return (
    <LorebookManagerErrorBoundary element={element}>
      <LorebookManagerDetail props={props} />
    </LorebookManagerErrorBoundary>
  );
}

class LorebookManagerElement extends HTMLElement {
  __root: ReturnType<typeof createRoot> | null = null;
  capabilityProps?: CapabilityElement["capabilityProps"];
  capabilityRuntimeError?: string | null;

  static observedAttributes = ["view"];

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === "view" && oldValue !== newValue && this.__root) this.render();
  }

  render() {
    this.__root?.render(
      <QueryClientProvider client={queryClient}>
        <CapabilityRoot element={this} />
      </QueryClientProvider>,
    );
  }

  connectedCallback() {
    if (!this.__root) this.__root = createRoot(this);
    this.render();
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (!this.isConnected && this.__root) {
        this.__root.unmount();
        this.__root = null;
      }
    });
  }
}

const tag = "marinara-capability-lorebook-manager";
if (!customElements.get(tag)) customElements.define(tag, LorebookManagerElement);
