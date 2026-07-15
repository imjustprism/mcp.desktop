# Discovery: Finding the Right Module

Minified names are meaningless and change every build. Discovery works from **observables**: strings you can see (UI text, CSS classes, action types, store names, error messages) back to the module that owns them. This reference covers the four discovery tools (`search`, `resolve`, `module`, `graph`) and when to use each.

All calls go to the `discord-dev` MCP server. Discord must be running with the plugin enabled, HTTP on 127.0.0.1:8486. Wrap multiple read-only lookups in one `batch` call to save round-trips.

## resolve: feature GPS (start here)

One call: "what owns this observable string?" Auto-detects the landmark type and routes to the right index:

| Landmark shape | Detected as | Example |
|---|---|---|
| 6 base64 chars | intl hash | `"jc4EFC"` |
| CSS class or 6-hex suffix | CSS module class | `"container_b2ca13"` or `"b2ca13"` |
| `PascalCase` + known displayName | Flux store | `"MessageStore"` |
| `SCREAMING_SNAKE` | intl key, action type, or enum member | `"MESSAGE_CREATE"`, `"MESSAGE_EDITED"` |
| anything else | literal string search | `"Copy Message Link"` |

```json
{ "tool": "resolve", "args": { "landmark": "MESSAGE_EDITED" } }
```
```json
{ "tool": "resolve", "args": { "landmark": "container_b2ca13", "limit": 5 } }
```

Returns owning module ID(s) plus role hints. If `resolve` gives you one confident module, skip straight to `module.explain`.

Output shape varies per detected landmark type. Read the `type` field to know which key holds your module:
- **Store name** → `{type:"store", definingModules:[], referencingModules:[{id, hint:"TypingStore (store)"}]}`. Empty `definingModules` is **normal**. The module you want is in `referencingModules`.
- **6-hex suffix** (`b2ca13`) resolves the CSS module. A **5-char suffix** (`guilds__5e434`) is too short to detect as CSS. It falls back to `type:"literal"` and finds the *consumer*, not the CSS module. For 5-char suffixes use `module { action: "css", className }` instead.
- **UI copy is a trap:** never `resolve` visible UI text as a literal. The top hit is the ~1.4MB locale-definition module (exports `default`, unpatchable by design, `genFinds` returns 0 candidates). Route UI text through `intl { action: "search" }` → `intl { action: "targets" }` (targets skips definition maps, returns real consumers).

## search: raw source grep

Searches all webpack module factory sources. Returns module IDs + surrounding context + a hint. Use when the observable is a code fragment rather than a semantic landmark, or when `resolve` returned nothing.

String or regex:

```json
{ "tool": "search", "args": { "pattern": "isRingtoneEligible" } }
```
```json
{ "tool": "search", "args": { "pattern": "/sendMessage\\((\\i),/i", "limit": 5 } }
```

`pattern` accepts `/regex/flags` syntax directly. `patterns` (array, 2-10 strings) is AND-mode. Only modules containing **all** strings match. This is the fastest way to narrow a common string to one module:

```json
{ "tool": "search", "args": { "patterns": ["premiumType", "guildMemberAvatars", "getAvatarURL"] } }
```

## module.find: targeted finders

Mirrors the Vencord webpack finder families, so a successful `find` translates directly into plugin code (`findByProps`, `findByCode`, `findComponentByDisplayName`, ...).

```json
{ "tool": "module", "args": { "action": "find", "props": ["getMessage", "getMessages"] } }
```
```json
{ "tool": "module", "args": { "action": "find", "code": ["MESSAGE_CREATE", "optimistic"] } }
```
```json
{ "tool": "module", "args": { "action": "find", "code": ["ChannelTextArea", "submit"] } }
```
```json
{ "tool": "module", "args": { "action": "find", "className": "wrapper_ef3116" } }
```
```json
{ "tool": "module", "args": { "action": "find", "exportName": "openModal" } }
```
```json
{ "tool": "module", "args": { "action": "find", "pattern": "/renderJumpButton/", "all": true, "limit": 10 } }
```

Notes:
- **`displayName` is nearly dead on modern builds. Expect `count:0` for React components.** React component displayNames survive mainly on Flux stores. A `find { displayName: "ChannelTextArea" }` returns 0 hits. The arg still works for the rare survivor, but for components steer to `code` (a code fragment from the component body) or `props`.
- `className` accepts both the semantic name (`container`) and a rendered class (`wrapper_ef3116`). The *semantic* name alone can miss (`className:"embedWrapper"` → `count:0` live). A rendered hashed class is the reliable lookup.
- `all: true` lists every match instead of the first. Use it to check uniqueness before writing a finder into a plugin.
- `exportValue` finds by exact export value (e.g. an enum constant).

## module.explain: the one-call dossier

Once you have a module ID, `explain` answers "what is this?" in one call: inferred role, real export names, imports, importedBy count, which plugins patch it, and an intl/store/dispatch fingerprint.

```json
{ "tool": "module", "args": { "action": "explain", "id": "384511" } }
```

Prefer this over `extract` as your first look. It is dense and does not dump 50k chars of minified source.

## Reading source without dumping it

- **structure**: outline (functions, exports, classes) without bodies:
  ```json
  { "tool": "module", "args": { "action": "structure", "id": "384511" } }
  ```
- **context**: N chars around a pattern inside the module (default 100):
  ```json
  { "tool": "module", "args": { "action": "context", "id": "384511", "pattern": "MESSAGE_EDITED", "chars": 300 } }
  ```
- **functionAt**: the full enclosing function at a pattern (right-sized extraction for patch authoring):
  ```json
  { "tool": "module", "args": { "action": "functionAt", "id": "384511", "pattern": "handleClickEdit" } }
  ```
- **extract**: full source, only when you truly need it (`patched: false` for original, `maxLength` to cap):
  ```json
  { "tool": "module", "args": { "action": "extract", "id": "384511", "patched": false, "maxLength": 20000 } }
  ```
- **annotate**: source with intl hashes resolved to keys, much more readable for UI modules.

Escalate `explain` → `structure` → `context`/`functionAt` → `extract`. Most tasks never need `extract`.

## graph: dependency context

Built from require call-sites in factory source, so it **works for unloaded modules** too.

```json
{ "tool": "graph", "args": { "action": "imports", "id": "384511" } }
```
```json
{ "tool": "graph", "args": { "action": "importedBy", "id": "384511", "limit": 30 } }
```
```json
{ "tool": "graph", "args": { "action": "path", "id": "384511", "to": "112233", "depth": 12 } }
```
```json
{ "tool": "graph", "args": { "action": "neighborhood", "id": "384511", "limit": 40 } }
```
```json
{ "tool": "graph", "args": { "action": "exports", "id": "384511" } }
```

Uses:
- `importedBy` disambiguates lookalike modules. A core store has hundreds of importers, a one-off helper has two.
- `path` verifies "does A actually depend on B?" before you assume a data flow.
- `exports` gives real public export names (RealName → local) even when the module has never executed. It is the only way to read the export surface of an unloaded module.
- `neighborhood` maps a feature cluster (nodes + edges) around one known module. `limit` now caps node count (default 60) and is honored, so lower it to keep a dense cluster readable.

## Lazy chunks: loadLazy + watch

Many features (settings pages, modals, dev tools) live in chunks that only load on first use, so `search`/`find` cannot see their source until they load. Two approaches:

1. Force-load everything, then search:
   ```json
   { "tool": "module", "args": { "action": "loadLazy" } }
   ```
   Note: `loadLazy` is mutating and is rejected inside `batch`.

2. Watch for modules registering while you (or the user) trigger the feature in the UI:
   ```json
   { "tool": "module", "args": { "action": "watch", "duration": 30000, "filter": "keybind" } }
   ```
   Then collect with `watchGet` (and end early with `watchStop`), passing the returned `watchId`:
   ```json
   { "tool": "module", "args": { "action": "watchGet", "watchId": 1 } }
   ```

`graph.exports` and `graph.imports` also work on unloaded modules, often enough to identify a lazy module without loading it at all.

## module.css: class index

Index/lookup for CSS-module classes. Given a semantic name or a rendered class, returns the owning CSS module and its full class map, useful for finding sibling classes. `resolve` on a single class gets you the module. `css` gets you the whole map.

Pass a **rendered hashed class**, not a bare semantic name. Semantic names alone often miss (`embedWrapper` → `count:0` live):

```json
{ "tool": "module", "args": { "action": "css", "className": "wrapper_ef3116" } }
```

Output shape:

```json
{ "totalIndexed": 2581, "count": 1, "matches": [
  { "moduleId": "803921", "hash": "ef3116", "classCount": 12, "matchingClasses": { "iE": "wrapper_ef3116" } }
] }
```

`matches[].matchingClasses` is the local-name → rendered-class map. Iterate the module's other classes from there.

## Decision table

| I have... | Call |
|---|---|
| Visible UI text (button label, tooltip, menu item) | **intl-first:** `intl { action: "search", query: "<text>" }` → `intl { action: "targets", key }` for the real consumers. Do NOT `resolve`/`search` UI text as a literal, it lands on the ~1.4MB unpatchable locale bundle |
| A CSS class from devtools (`wrapper_ef3116`) | `resolve { landmark: "wrapper_ef3116" }`. Use `module { action: "css", className }` for the full class map. 5-char suffixes: skip `resolve`, go straight to `css` |
| A store name (or a guess at one) | `resolve { landmark: "MessageStore" }` (module is in `referencingModules`) or `store { action: "find", name: "Message" }` (auto-resolves partials) |
| An action type (`MESSAGE_CREATE`) | `resolve { landmark: "MESSAGE_CREATE" }`, then `flux { action: "producers"/"listeners" }` for who dispatches/handles it |
| A component name | `module { action: "find", code: ["<body fragment>"] }` or `props: [...]`. **`displayName` is extinct for React components on modern builds (count:0).** Only reach for it on Flux stores |
| Known export props | `module { action: "find", props: [...] }` |
| A code fragment / error message | `search { pattern }`, or `search { patterns: [...] }` AND-mode to narrow |
| Nothing but a pixel (an on-screen element) | `react { action: "source", selector: "<css selector>" }` bridges DOM element → webpack module + export name. `nearest` is often a design-system primitive. If the whole stack is primitives, pivot to the element's intl label via `intl.search` → `intl.targets` |
| A module ID, need to understand it | `module { action: "explain", id }`, then `structure`/`context`/`functionAt` |
| A module that isn't loaded yet | `graph { action: "exports"/"imports", id }`, or `module.loadLazy` / `module.watch` to get it loaded |
| Two candidate modules, unsure which | `graph { action: "importedBy" }` counts + `module.explain` on each (batchable) |
| A broken patch whose module *moved* (stale find) | `patch { action: "broken" }` → read the `partialMatch` field (`{fragment, modules}`), which names the module the stale find still partially matches. Seed `partialMatch.modules` into `module { action: "genFinds" }` to rediscover fresh durable finds |

After discovery, validate any find/patch with `testPatch` before writing it into a plugin. See the patching reference.
