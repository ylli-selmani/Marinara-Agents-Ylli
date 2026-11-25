import type { Root } from "react-dom/client";

export type CapabilityProps = {
  package?: {
    name?: string;
    version?: string;
    readiness?: string;
    status?: string;
  };
  agent?: {
    id?: string;
    name?: string;
    description?: string;
    author?: string | null;
  };
  chatId?: string | null;
  chatName?: string | null;
  chatMode?: "conversation" | "roleplay" | "game" | null;
  onClose?: () => void;
  onOpenLorebook?: (lorebookId: string) => void;
  onLorebooksChanged?: () => void | Promise<void>;
  engineHeader?: boolean;
  headerSlot?: HTMLElement | null;
};

export type CapabilityElement = HTMLElement & {
  capabilityProps?: CapabilityProps;
  capabilityRuntimeError?: string | null;
  __root?: Root | null;
};
