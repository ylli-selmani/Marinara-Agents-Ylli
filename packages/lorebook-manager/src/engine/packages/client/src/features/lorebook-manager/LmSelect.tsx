import { getHostComponents } from "./host-components";

interface LmSelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}

export function LmSelect({
  value,
  options,
  onChange,
  label,
  ...props
}: {
  value: string;
  options: readonly LmSelectOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  id?: string;
}) {
  const HostSelect = getHostComponents().Select;
  if (HostSelect) {
    return (
      <HostSelect
        {...props}
        value={value}
        options={options.map(({ disabled, ...option }) => ({
          ...option,
          disabledReason: disabled ? "Not available" : undefined,
        }))}
        onChange={onChange}
        label={label}
      />
    );
  }

  const groups: { group?: string; options: LmSelectOption[] }[] = [];
  for (const option of options) {
    const previous = groups.at(-1);
    if (previous && previous.group === option.group) previous.options.push(option);
    else groups.push({ group: option.group, options: [option] });
  }

  return (
    <select {...props} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {groups.map(({ group, options }, index) => {
        const children = options.map((option) => (
          <option key={option.value} value={option.value} title={option.description} disabled={option.disabled}>
            {option.label}
          </option>
        ));
        return group ? (
          <optgroup key={index} label={group}>
            {children}
          </optgroup>
        ) : (
          children
        );
      })}
    </select>
  );
}
