# Lorebook Manager

Lorebook Manager adds an interactive graph and list workbench over your existing Marinara Engine lorebooks, Character Cards, and Personas. It stores explicit entry-to-entry and entry-to-card links in each entry's standard `relationships` map, detects keyword and name mentions across entry text in local code, and lets you inspect or edit entries directly without an external tool or separate database.

## Before you start

Lorebook Manager requires Marinara Engine `>=2.5.2 <4.0.0` (Capability API `1.390`) and supports Conversation, Roleplay, and Game modes (`agents.json`).

In this release (`runtimeDisabled: true`), you can organize, tag, edit, and link lorebooks from the workbench, while pre-generation chat retrieval and post-turn lorebook updates remain disabled until the runtime pipeline is finished. Lorebook Manager does not duplicate World Maps locations; once runtime retrieval is turned on, it is designed to read World Maps location state and coordinate with Engine `current_location` activations so location-linked entries are not injected twice.

## Install and open

Once published to a catalog lane, install Lorebook Manager from **Agents → Download Agents** and restart Marinara Engine when prompted (`restartRequired: true`). During early development, the package stays hidden in `INCOMPLETE_PACKAGE_IDS` (`scripts/catalog-incomplete.mjs`) unless built locally with `MARINARA_CATALOG_INCLUDE_INCOMPLETE=1`.

To open the workbench, go to **Agents → Lorebook Manager**. It renders inside the agent detail view rather than a Home tab.

## Try it

1. Select one or more books in the **Managed lorebooks** bar (or click the collapse icon beside an active book pill to fold a whole book into a single hub node). Switch between **Graph** and **List** at the top right, filter by category pills or **Hide unlinked**, and adjust the **Spacing** slider. You can also drag any node to pin it and click **Reset dragged node positions** in the top-right zoom controls to restore automatic placement.
2. Click any node to open the inspector, or double-click a node to toggle **Focus (2-hop)** around its neighbors (**Show all** or **Whole graph** exits focus mode). Click **Read full** for untruncated text, **Edit** to change the entry's name, tag, keywords, description, or content, or **Open lorebook** to jump to that book in Marinara Engine's editor.
3. Under **ID links** and **Add ID link**, pick a target and relation to create a manual link, or click the edit icon on an existing link to change its relation, toggle **Both ways**, or click **Flip**.
4. Under **Detected mentions**, choose a relation in **Promote as**, pick **This → Other**, **Other → This**, or **Both ↔**, and click **Promote** on a row. The dashed mention disappears from **Detected mentions** and turns into a solid link under **ID links** with directional or double-headed arrows that highlight by relation type when hovered or selected.

## Tags and relationships

Lorebook Manager reads comma-separated values from each entry's `tag` field (`lore`, `character`, `location`, `faction`, `item`, `creature`, `ability`, `quest`, singular or plural). Multi-tags such as `location, faction` match every listed filter pill and draw a dashed secondary ring around the node.

Character Cards render as cyan hexagons and Personas as pink diamonds so they stay visually distinct from blue `character` lorebook entries, and linked books connect to their cards and personas through book hub nodes. Untagged entries inside `character`, `npc`, or `spellbook` lorebooks stay counted under **Lore** with a diagonal-hatched fill until you pick **lore (explicit)** or another tag in the inspector.

Each explicit ID link stores one of these relation labels in `entry.relationships`. Character Cards and Personas can't store links themselves, so a link with them always lives on the entry; with `related_to`, `ally_of` or `rival_of` it counts as both ways. Picking `represents` also adds the card to the entry's Exclude character filter:

| Relation     | Symmetry                | Intended direction                                 | Planned 1-hop retrieval role                                       |
| ------------ | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `part_of`    | Directed                | Sub-entry to parent (`Personality` → `Character`)  | Strongest structural pull so sub-entries surface with their parent |
| `located_in` | Directed                | Thing or sub-place to containing place             | Boosted when the active scene or World Maps location matches       |
| `member_of`  | Directed                | Person or squad to group (`Student` → `Class 1-A`) | Pulls group context when an active member appears                  |
| `owns`       | Directed                | Owner to item or property                          | Surfaces signature gear or possessions when relevant               |
| `ally_of`    | Symmetric (`Both ways`) | Mutual link between allies                         | Soft social candidate for Stage 2 filtering                        |
| `rival_of`   | Symmetric (`Both ways`) | Mutual link between rivals                         | Soft social candidate for Stage 2 filtering                        |
| `related_to` | Symmetric (`Both ways`) | General two-way link                               | Lightest fallback connection and graph navigation                  |
| `represents` | Directed                | Entry to Character Card (`Izuku entry` → `Izuku`)  | Excludes the entry while the card is active; the card inherits the entry's links |

## When something goes wrong

- **No lorebooks appear on first open** — Multi-book libraries with more than 400 total entries start unloaded so the browser does not parse the whole library at once. Click books in **Managed lorebooks** to opt them in; the selection is stored in browser `localStorage` under `lm:managed-books:v1`.
- **Missing API routes or stale UI after an update** — Restart Marinara Engine (`restartRequired: true`) so `server.mjs` re-registers its backend routes and serves the matching `client.js` bundle.
- **Data retention on uninstall** — Entry edits, tags, and `relationships` links write directly to standard Marinara Engine lorebooks. Removing Lorebook Manager leaves your lorebooks and links intact; only the browser-local book opt-in list remains in `lm:managed-books:v1`.

## Development notes

- Source files live under `packages/lorebook-manager/src/engine/packages/{client,server,shared}/`.
- Generated files (`client.js`, `server.mjs`, `manifest.json`, `locales/en.json`, and ZIP packages under `artifacts/`) are written by `scripts/build-feature-packages.mjs`. Do not edit generated artifacts by hand; rebuild against a neighboring Marinara Engine checkout with:

```bash
MARINARA_ENGINE_ROOT=/path/to/Marinara-Engine node scripts/build-feature-packages.mjs lorebook-manager
```
