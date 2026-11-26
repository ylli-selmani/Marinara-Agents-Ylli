import { LM_RELATIONS } from "../../../../shared/src/features/agents/lorebook-manager/relations.js";
import { getHostComponents, type HostSelectOption } from "./host-components";

/**
 * Relation picker: the host's shared Select (hint as subtext) when the Engine provides it,
 * a native select with the hint as tooltip otherwise.
 */
export function RelationPicker({
  value,
  onChange,
  ariaLabel,
  fallbackClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  fallbackClassName: string;
}) {
  const HostSelect = getHostComponents().Select;
  // Keep a relation from older data selectable even if it isn't in the catalog.
  const custom = value && !LM_RELATIONS.some((relation) => relation.value === value) ? value : null;
  const options: HostSelectOption[] = [
    ...LM_RELATIONS.map((relation) => ({ value: relation.value, label: relation.value, description: relation.hint })),
    ...(custom ? [{ value: custom, label: custom, description: "Custom relation" }] : []),
  ];

  if (HostSelect) {
    return <HostSelect value={value} options={options} onChange={onChange} label={ariaLabel} title={ariaLabel} />;
  }
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={fallbackClassName}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} title={option.description}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface LinkTargetOption {
  ref: string;
  name: string;
  nodeType: "lore" | "character" | "persona";
  lorebookName?: string;
}

/**
 * Searchable link-target picker grouped into Entries / Character Cards / Personas, with the lorebook as subtext.
 * Falls back to a native select when the host has no shared Select.
 */
export function LinkTargetPicker({
  value,
  targets,
  onChange,
  placeholder,
  fallbackClassName,
}: {
  value: string;
  targets: readonly LinkTargetOption[];
  onChange: (value: string) => void;
  placeholder: string;
  fallbackClassName: string;
}) {
  const HostSelect = getHostComponents().Select;
  const options: HostSelectOption[] = targets.map((target) => ({
    value: target.ref,
    label: target.name,
    description:
      target.nodeType === "lore" ? target.lorebookName : target.nodeType === "character" ? "Character Card" : "Persona",
    searchText: `${target.name} ${target.lorebookName ?? ""}`,
    group: target.nodeType === "lore" ? "Entries" : target.nodeType === "character" ? "Character Cards" : "Personas",
  }));

  if (HostSelect) {
    return (
      <HostSelect
        value={value || null}
        options={options}
        onChange={onChange}
        label="Link target"
        title="Link target"
        placeholder={placeholder}
        searchable
        className="min-w-0 flex-1"
      />
    );
  }
  return (
    <select
      aria-label="Target entity"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={fallbackClassName}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
          {option.description ? ` · ${option.description}` : ""}
        </option>
      ))}
    </select>
  );
}
