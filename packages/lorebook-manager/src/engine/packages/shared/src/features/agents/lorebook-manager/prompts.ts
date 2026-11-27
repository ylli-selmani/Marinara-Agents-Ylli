import { LM_RELATIONS, type LmRelationDefinition } from "./relations.js";
import type { LmPromptKey, LmPromptOverrides } from "./schema.js";

/**
 * The package's model prompts, editable in Settings → Prompts (Ylli, 2026-11-27: "like LTM, so I can fine-tune
 * myself"). Each is instructions a person may change plus an answer format the code reads, which always comes last
 * and can't be edited, so an edited prompt can't break the parsing. `{{name}}` variables are filled in when the prompt
 * is used.
 */

/**
 * Relations the Crawler may write: the specific ones. `related_to` says nothing a mention doesn't, and the Crawler
 * spammed it to everything an entry names (Ylli's round 5); a person can still add it. `represents` hides an entry
 * while its card is active: a person's call too. `part_of` pulls hardest, both ways, and is meant for a section split
 * off the same subject; the model used it for "a form of" and "belongs to" (round 6), so only a person writes it.
 */
export const CRAWLER_RELATION_DEFS: readonly LmRelationDefinition[] = LM_RELATIONS.filter(
  (relation) => !["related_to", "represents", "part_of"].includes(relation.value),
);

/** The categories an Archivist create may have; they route it to a book and name its kind. */
export const ARCHIVIST_CATEGORIES = [
  "character",
  "location",
  "item",
  "faction",
  "species",
  "creature",
  "ability",
  "quest",
  "event",
  "concept",
] as const;

export const LM_PROMPT_MAX_CHARS = 20_000;

export interface LmPromptVariable {
  name: string;
  description: string;
}

export interface LmPromptDefinition {
  key: LmPromptKey;
  label: string;
  /** When it runs and what it decides, for the Settings tab. */
  description: string;
  instructions: string;
  /** The fixed last part: the JSON the code reads. */
  format: string;
  variables: readonly LmPromptVariable[];
}

const TIDY_INSTRUCTIONS = [
  "You tidy a roleplay's lorebook so the right entries come up during play. Every entry in <entries> gets an answer.",
  "",
  "description: REQUIRED for every entry whose description says (none): one plain sentence saying what the entry is",
  "(who, what or where), from its text. It is the most important field; never skip it for such an entry. Leave it",
  "out only where the entry has one already.",
  "tag: one or two lowercase words for its kind (character, location, item, faction, species, ability, event,",
  "concept, ...). Only if the entry has none.",
  'fields: for an entry with "missing sheet lines", the ones its own text clearly states, as {"field", "value"};',
  "value is a short single line copied or condensed from the text. Never guess, never use outside knowledge of the",
  'story, never "Unknown"; leave a field out when the text doesn\'t say it.',
  "",
  "A card stub is a full character lore entry; fill its missing sheet lines from its text too.",
  "Everything else: only what is clearly missing or wrong. Most entries need few or no keyword changes.",
  "",
  "Keywords bring an entry into the story whenever one appears in the chat, without any further check. So:",
  "addKeys: at most 2 names or aliases the story really calls it by and the entry lacks. Never descriptions",
  '("red-haired shinobi"), names of other things, or generic phrases.',
  "removeKeys: only a common word that is too broad on its own and would bring the entry in for unrelated text",
  '("Ten" for Ten-Tails, "Team" for Team Guy, "Shadow" for Shadow Clone Technique, "Dark", "water"). A key marked',
  '"also a key of N other entries" is a sign, if it is such a word. Never remove a proper name, alias or title, even',
  "a single word and even one another entry shares (Shukaku, Kurama, Kagetsu): that is how the story calls it. Never",
  "the entry's own name. Copy keys exactly. To replace an entry's only key, put the better one in addKeys.",
  'constant: false, only for an entry marked "always on: yes" that isn\'t lore every scene needs (a person, place or',
  "event that matters only when it comes up).",
  "",
  'Never invent keys; leave them out when unsure. An entry that has a description and needs nothing else is just {"id": "e2"}.',
].join("\n");

const TIDY_FORMAT = [
  "Answer with JSON only:",
  '{"entries": [{"id": "e1", "description": "...", "tag": "...", "addKeys": ["..."], "removeKeys": ["..."],',
  '"constant": false, "fields": [{"field": "...", "value": "..."}]}]}',
].join("\n");

const LINKS_INSTRUCTIONS = [
  "You link a roleplay's lorebook entries, so that when one comes up in the story the entries it depends on come",
  'along. A link is a lasting fact and reads "<entry> <relation> <target>". Only these relations:',
  "{{relations}}",
  "",
  "For each entry in <entries>, pick from the targets listed under it; each target comes with its summary. Most",
  "entries have one or two real links: what kind of thing it is (is_a), the group it belongs to (member_of), where it",
  "is (located_in), what it leads or owns, a lasting ally or rival. An entry with none of these gets no links.",
  "",
  "Link only when the relation is plainly true from the entry's text and the target's summary. Naming, mentioning or",
  "comparing a target is not a link: an encounter prompt that names three teams links to none of them. Mind the",
  "direction: the entry itself must be what the relation says. A team is not a member_of its members' clans; a",
  "member's own entry is member_of the team. Link to the",
  "closest kind, group or place only: an entry that is_a Ninjutsu gets no is_a Jutsu as well. Something that belongs",
  "to someone (a bloodline, a weapon) gets no link to its owner; the owner's own entry links to it with owns. At most",
  "3 links per entry. The entry's existing links are listed; don't repeat them. When no relation above fits exactly,",
  "leave the link out.",
].join("\n");

const LINKS_FORMAT = [
  "Answer with JSON only, one item per entry (links may be empty):",
  '{"entries": [{"id": "e1", "links": [{"to": "t3", "relation": "member_of"}]}]}',
].join("\n");

const ARCHIVIST_INSTRUCTIONS = [
  "You keep a roleplay's lorebook up to date as sheets of Field: value lines, not event logs.",
  "Read recent messages and report only lasting facts or current-state facts they establish. Never invent.",
  "Never write events, passing actions, dialogue, guesses or unstated values. Events belong to the Memory agent.",
  "File each fact on the entry it is about. Currently is the replaceable field for temporary details, such as",
  "where someone is right now or a passing condition. Rewrite it when that state changes; never append a history.",
  "",
  "A card stub is a full character lore entry for when the character is only mentioned; keep its whole sheet current.",
  "updates: use only c* ids from <entries>, never d* ids from <directory>, whose content you have not seen.",
  "Each fields item changes one line. field must be in that entry's sheet in <sheets> or already be a Field: line",
  "in its text. value is the whole new value of that line, combining still-true details with the new fact.",
  "Do not repeat a value the entry already has. Values are single-line; omit empty or unstated fields, never Unknown.",
  "creates: a new entry for a named person, place, item, faction or idea absent from <entries> and <directory>",
  "under any name. Well-known characters too: record this story's version. Nameless figures get no entry.",
  "category: one of {{categories}}. Use its family template from <sheets>; event uses quest, concept uses lore.",
  "fields: only fields the messages state, in template order. An empty template stays free text: use short prose content",
  "instead of fields. keys: 1-4 names or aliases it is called by.",
  "If nothing changed, answer with empty lists.",
].join("\n");

const ARCHIVIST_FORMAT = [
  "Answer with JSON only:",
  '{"updates": [{"id": "c1", "fields": [{"field": "Role", "value": "..."}]}],',
  '"creates": [{"name": "...", "category": "character", "fields": [{"field": "Role", "value": "..."}], "keys": ["..."]}]}',
  'For creates with an empty template, use "content": "short prose" instead of "fields".',
].join("\n");

const LIBRARIAN_INSTRUCTIONS = [
  "You are the Librarian of a roleplay's lorebook. Some entries were found only because they share words or meaning",
  "with the latest messages, and some of those are noise. Keep an entry only if the story right now involves it, or the",
  "writer would plainly need it for the next reply. When unsure, keep it.",
].join("\n");

const LIBRARIAN_FORMAT = 'Answer with JSON only: {"keep": ["e1", "e3"]}. Use only the ids listed.';

export const LM_PROMPTS: readonly LmPromptDefinition[] = [
  {
    key: "tidy",
    label: "Tidy",
    description:
      "The Crawler's first call per batch: a summary and a tag where an entry has none, keyword fixes and always on.",
    instructions: TIDY_INSTRUCTIONS,
    format: TIDY_FORMAT,
    variables: [],
  },
  {
    key: "links",
    label: "Links",
    description:
      "The Crawler's second call per batch: links from each entry to the targets listed under it, each with its summary.",
    instructions: LINKS_INSTRUCTIONS,
    format: LINKS_FORMAT,
    variables: [{ name: "relations", description: "the relations the Crawler may write, one per line with its hint" }],
  },
  {
    key: "archivist",
    label: "Archivist",
    description: "Reads settled messages every few turns and suggests new facts for entries and new entries.",
    instructions: ARCHIVIST_INSTRUCTIONS,
    format: ARCHIVIST_FORMAT,
    variables: [{ name: "categories", description: "the categories a new entry may have" }],
  },
  {
    key: "librarian",
    label: "Librarian",
    description:
      "Checks loose matches before a turn, when Check loose matches is set to Librarian: which entries to keep.",
    instructions: LIBRARIAN_INSTRUCTIONS,
    format: LIBRARIAN_FORMAT,
    variables: [],
  },
];

export const LM_PROMPT_KEYS: readonly LmPromptKey[] = LM_PROMPTS.map((prompt) => prompt.key);

export function promptDefinition(key: LmPromptKey): LmPromptDefinition {
  return LM_PROMPTS.find((prompt) => prompt.key === key)!;
}

function variableValues(): Record<string, string> {
  return {
    relations: CRAWLER_RELATION_DEFS.map((relation) => `- ${relation.value}: ${relation.hint}`).join("\n"),
    categories: ARCHIVIST_CATEGORIES.join(", "),
  };
}

/** The system prompt as sent: the instructions (edited or built in) with variables filled in, then the format. */
export function composePrompt(key: LmPromptKey, overrides?: LmPromptOverrides | null): string {
  const definition = promptDefinition(key);
  const values = variableValues();
  let instructions = (overrides?.[key] ?? "").trim() || definition.instructions;
  for (const variable of definition.variables) {
    instructions = instructions.split(`{{${variable.name}}}`).join(values[variable.name] ?? "");
  }
  return `${instructions.trim()}\n\n${definition.format}`;
}

/**
 * Only real edits: a string per known prompt, at most LM_PROMPT_MAX_CHARS; blank text or the built-in text itself
 * means no edit, so "Reset to built-in" and an untouched box store the same thing.
 */
export function normalizePromptOverrides(raw: unknown): LmPromptOverrides {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result: LmPromptOverrides = {};
  for (const definition of LM_PROMPTS) {
    const value = record[definition.key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\r\n/gu, "\n").slice(0, LM_PROMPT_MAX_CHARS);
    if (!text.trim() || text.trim() === definition.instructions.trim()) continue;
    result[definition.key] = text;
  }
  return result;
}
