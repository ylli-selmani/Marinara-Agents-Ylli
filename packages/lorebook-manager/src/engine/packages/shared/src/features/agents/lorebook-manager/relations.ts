/**
 * The relation labels Lorebook Manager offers for explicit ID links, in picker order.
 * One source for the pickers (label + hint), the graph colours and the 1-hop retrieval policy.
 * Links store only `value` in `entry.relationships`; unknown values from older data still work as plain links.
 */
export interface LmRelationDefinition {
  value: string;
  /** One line shown as picker subtext: what it means, with an example. */
  hint: string;
  /** Reads the same both ways (`A ally_of B` = `B ally_of A`). */
  symmetric: boolean;
}

export const LM_RELATIONS: readonly LmRelationDefinition[] = [
  { value: "related_to", hint: "General two-way link, when nothing more specific fits", symmetric: true },
  {
    value: "part_of",
    hint: "A split-off section of the same subject: Roswaal's Personality → Roswaal",
    symmetric: false,
  },
  { value: "is_a", hint: "A kind, form or instance of: Dark Elf → High Elf, Shiza → Dark Fae", symmetric: false },
  { value: "member_of", hint: "Belongs to a group: Student → Class 1-A", symmetric: false },
  { value: "leads", hint: "Rules or heads a group: Syliveera → Unseelie Court", symmetric: false },
  { value: "located_in", hint: "Lives or sits inside a place: Fae → Fae Realm", symmetric: false },
  { value: "owns", hint: "Has an item, power or bloodline: Knight → Sword", symmetric: false },
  { value: "ally_of", hint: "Friends or allies, both ways", symmetric: true },
  { value: "rival_of", hint: "Enemies or rivals, both ways", symmetric: true },
  {
    value: "represents",
    hint: "This entry is that Character Card's stub: while the card is active, only its current-state lines are sent",
    symmetric: false,
  },
];

export const LM_RELATION_VALUES: readonly string[] = LM_RELATIONS.map((relation) => relation.value);
