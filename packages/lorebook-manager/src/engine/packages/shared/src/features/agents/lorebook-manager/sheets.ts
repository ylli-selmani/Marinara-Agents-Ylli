import { ENTITY_FAMILIES, type EntityFamily } from "./schema.js";

export const LM_STUB_FIELDS = ["Role", "Affiliation", "Relationships", "Status", "Currently"] as const;

export type LmSheetOverrides = Partial<Record<EntityFamily, string[]>>;
export interface LmFieldEdit {
  field: string;
  from: string | null;
  to: string;
}

export const LM_SHEET_TEMPLATES: Readonly<Record<EntityFamily, readonly string[]>> = {
  character: [
    "Aliases",
    "Role",
    "Affiliation",
    "Age",
    "Appearance",
    "Personality",
    "Abilities",
    "Relationships",
    "Status",
    "Currently",
  ],
  location: ["Type", "Region", "Atmosphere", "Notable features", "Inhabitants", "Status", "Currently"],
  faction: ["Type", "Leader", "Headquarters", "Members", "Goals", "Stance", "Status", "Currently"],
  item: ["Type", "Owner", "Properties", "Condition", "Origin", "Currently"],
  creature: ["Nature", "Habitat", "Abilities", "Weaknesses", "Status", "Currently"],
  species: ["Traits", "Origin", "Habitat", "Notable members"],
  ability: ["Type", "Users", "Effect", "Requirements", "Limits"],
  quest: ["Goal", "Giver", "Status", "Steps", "Reward", "Currently"],
  lore: [],
};

export function sheetFamily(family: unknown): EntityFamily {
  if (family === "event") return "quest";
  return ENTITY_FAMILIES.includes(family as EntityFamily) ? (family as EntityFamily) : "lore";
}

export function sheetFields(family: unknown, overrides?: LmSheetOverrides): readonly string[] {
  const key = sheetFamily(family);
  return key === "lore" ? [] : (overrides?.[key] ?? LM_SHEET_TEMPLATES[key]);
}

export function sheetFieldName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const field = raw.trim();
  return !field || field.length > 40 || /[:\r\n"'“”‘’]|\/\/|\*\*/u.test(field) ? "" : field;
}

export function normalizeSheetOverrides(raw: unknown): LmSheetOverrides {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result: LmSheetOverrides = {};
  for (const family of ENTITY_FAMILIES) {
    if (family === "lore" || !Array.isArray(record[family])) continue;
    const seen = new Set<string>();
    const fields: string[] = [];
    for (const raw of record[family] as unknown[]) {
      const field = sheetFieldName(typeof raw === "string" ? raw.trim().slice(0, 40) : raw);
      if (!field || seen.has(field.toLowerCase())) continue;
      seen.add(field.toLowerCase());
      fields.push(field);
      if (fields.length === 20) break;
    }
    if (JSON.stringify(fields) !== JSON.stringify(LM_SHEET_TEMPLATES[family])) result[family] = fields;
  }
  return result;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const fieldPattern = (field: string) => new RegExp(`^\\s*${escapeRegex(field)}\\s*:[ \\t]*`, "iu");

export function sheetValue(field: string, raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim().replace(fieldPattern(field), "").trim() : "";
}

/** Plain Field: lines only: **Field:** markdown is not matched; values are single-line. */
export function parseSheetLines(content: string): Array<{ field: string; value: string }> {
  return content.split(/\r?\n/u).flatMap((line) => {
    if (/^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\d{1,2}:\d{2}\b)/iu.test(line)) return [];
    const match = /^\s*([^:]+?)\s*:[ \t]*(.*)$/u.exec(line);
    const field = sheetFieldName(match?.[1]);
    return field ? [{ field, value: match![2]!.trim() }] : [];
  });
}

/** Recognized, populated sheet lines only, in their original content order. */
export function stubSheetLines(content: string): string[] {
  const fields = new Set([...LM_STUB_FIELDS, ...LM_SHEET_TEMPLATES.character].map((field) => field.toLowerCase()));
  return parseSheetLines(content)
    .filter((line) => fields.has(line.field.toLowerCase()) && line.value)
    .map(({ field, value }) => `${field}: ${value}`);
}

export function missingSheetFields(content: string, family: unknown, overrides?: LmSheetOverrides): string[] {
  const present = new Set(parseSheetLines(content).map((line) => line.field.toLowerCase()));
  return sheetFields(family, overrides).filter((field) => !present.has(field.toLowerCase()));
}

export function sheetFieldEdits(
  content: string,
  template: readonly string[],
  raw: unknown,
  includeUnchanged = false,
): LmFieldEdit[] {
  const lines = parseSheetLines(content);
  const allowed = [...template, ...lines.map((line) => line.field)];
  const edits: LmFieldEdit[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    const name = sheetFieldName(item.field);
    const field = allowed.find((field) => field.toLowerCase() === name.toLowerCase());
    if (!field) continue;
    const to = sheetValue(field, item.value);
    const from = lines.find((line) => line.field.toLowerCase() === field.toLowerCase())?.value ?? null;
    if (to) edits.push({ field, from, to });
  }
  return foldFieldEdits([], edits, includeUnchanged);
}

export function normalizeFieldEdits(raw: unknown): LmFieldEdit[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const field = sheetFieldName(item.field);
    const to = field ? sheetValue(field, item.to) : "";
    return field && to && (item.from === null || typeof item.from === "string") ? [{ field, from: item.from, to }] : [];
  });
}

export function foldFieldEdits(
  existing: readonly LmFieldEdit[],
  incoming: readonly LmFieldEdit[],
  includeUnchanged = false,
): LmFieldEdit[] {
  const edits = new Map<string, LmFieldEdit>();
  for (const edit of [...existing, ...incoming]) {
    const key = edit.field.toLowerCase();
    const first = edits.get(key);
    edits.set(key, first ? { ...first, to: edit.to } : { ...edit });
  }
  return [...edits.values()].filter((edit) => includeUnchanged || edit.from !== edit.to);
}

export function applyFieldEdits(content: string, edits: readonly LmFieldEdit[]): string {
  const ending = content.includes("\r\n") ? "\r\n" : "\n";
  for (const edit of edits) {
    const pattern = fieldPattern(edit.field);
    const lines = content.split(/\r?\n/u);
    const index = lines.findIndex((line) => pattern.test(line));
    const value = sheetValue(edit.field, edit.to);
    if (!value) continue;
    if (index >= 0) {
      lines[index] = `${lines[index]!.match(pattern)![0]}${value}`;
      content = lines.join(ending);
    } else content = `${content}${content && !content.endsWith("\n") ? ending : ""}${edit.field}: ${value}`;
  }
  return content;
}

export function createSheetContent(template: readonly string[], raw: unknown): string {
  const edits = sheetFieldEdits("", template, raw);
  return template
    .flatMap((field) => {
      const edit = edits.find((edit) => edit.field.toLowerCase() === field.toLowerCase());
      return edit ? [`${field}: ${edit.to}`] : [];
    })
    .join("\n");
}
