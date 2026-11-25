import type { ComponentType, ReactNode } from "react";
import { host } from "marinara:host";

export interface HostModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  mobileFullscreen?: boolean;
}

export interface HostSelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  searchText?: string;
  disabledReason?: string;
  group?: string;
}

export interface HostSelectProps<T extends string = string> {
  value: T | null;
  options: readonly HostSelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  searchable?: boolean;
}

export interface HostCharacterSelectMultiProps {
  kind: "character" | "persona";
  multiple: true;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export interface HostLibraryLorebook {
  id: string;
  name: string;
  imagePath?: string | null;
  imageCrop?: unknown;
  enabled?: boolean;
}

export interface HostLorebookListFieldProps {
  lorebooks: readonly HostLibraryLorebook[];
  selectedIds: readonly string[];
  onToggle: (id: string) => void;
  onAdd: (ids: string[]) => void;
  onApplySet?: (ids: string[]) => void;
  triggerClassName: string;
  ariaLabel?: string;
  keepMissing?: boolean;
  disabled?: boolean;
}

export type HostShowConfirmDialog = (options: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}) => Promise<boolean>;

type HostComponentsRecord = {
  Modal?: ComponentType<HostModalProps>;
  Select?: <T extends string>(props: HostSelectProps<T>) => ReactNode;
  CharacterSelect?: ComponentType<HostCharacterSelectMultiProps>;
  LorebookListField?: ComponentType<HostLorebookListFieldProps>;
  showConfirmDialog?: HostShowConfirmDialog;
};

function readHostComponents(): HostComponentsRecord {
  const candidate = (host as { components?: unknown } | undefined)?.components;
  if (!candidate || typeof candidate !== "object") return {};
  return candidate as HostComponentsRecord;
}

export function getHostComponents(): HostComponentsRecord {
  return readHostComponents();
}

export async function confirmWithHostOrBrowser(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
}): Promise<boolean> {
  const showConfirmDialog = readHostComponents().showConfirmDialog;
  if (typeof showConfirmDialog === "function") {
    return showConfirmDialog({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      variant: options.variant,
    });
  }
  if (typeof window === "undefined") return false;
  return window.confirm(options.message);
}
