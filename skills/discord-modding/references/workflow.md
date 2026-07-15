# End-to-End Patch Workflow

The lifecycle of a Vencord/Equicord patch, from an on-screen pixel to a verified-applied patch that survives Discord updates. Each stage lists the exact `discord-dev` tool call(s). All tool/action/arg names are taken verbatim from `tools/definitions.ts`. Minified identifiers change every build; never hardcode them — anchor on intl keys, string literals, and structural landmarks.

Golden rule: a `find` selects the module; a `match` regex selects the injection site inside it. The `find` must be unique among candidate modules; the `match` must be unique inside the found module and durable across builds.

---

## 1. Locate the target module

You have a symptom (an on-screen element, a visible string, a store name, a component). Convert it to a module ID.

### 1a. From an on-screen element — `react.source`
The pixel-to-source bridge. Give it a CSS selector for something currently rendered; it returns the owning webpack module(s), export name, a role hint, and `patchedBy`.

```json
{ "tool": "react", "args": { "action": "source", "selector": "[class*='chatContent'] button[aria-label='Send Message']" } }
```

### 1b. From a visible string / regex — `search`
Full-text search over module factory sources. Returns IDs + surrounding context + a hint. Use `/regex/flags`, or `patterns` for an AND search (module must contain ALL strings).

```json
{ "tool": "search", "args": { "pattern": "/canBeUsedAsRingtone/", "limit": 10 } }
```
```json
{ "tool": "search", "args": { "patterns": ["MESSAGE_REACTION_ADD", "getReaction"], "limit": 5 } }
```

### 1c. From any observable landmark — `resolve`
Feature GPS. Auto-detects the landmark type (intl hash, CSS class or 6-hex suffix, StoreName, SCREAMING_SNAKE intl key / action type / enum member, or literal) and returns owning modules + role hints. The single best call when you only know "what owns this string."

```json
{ "tool": "resolve", "args": { "landmark": "MESSAGE_EDITED" } }
```
```json
{ "tool": "resolve", "args": { "landmark": "container_b2ca13" } }
```

> Do NOT feed **visible UI copy** to `resolve`/`search` as a literal. UI strings live behind intl keys — the top literal hit is the ~1.4MB locale-definition module (exports only `default`; `genFinds` returns 0 candidates; unpatchable by design). That is a dead end. Route UI text through `intl` instead (1d).

### 1d. From visible UI copy — intl-first (`intl.search` → `intl.targets`)
For any string a user can read on screen, go intl-first. `intl.search` maps the visible text to its intl key(s)/hash; `intl.targets` returns the modules that **consume** that key (it skips the definition maps, so you land on the feature, not the locale bundle).

```json
{ "tool": "intl", "args": { "action": "search", "query": "Inbox" } }
```
```json
{ "tool": "intl", "args": { "action": "targets", "key": "INBOX" } }
```
Take the owning module id from `targets` into step 2, then anchor patches on `#{intl::INBOX}` (never the raw English text).

### 1e. From exports / props / component — `module.find`
When you know the shape of the module rather than a string in it. Search by `props`, `code`, `displayName`, `className`, `exportName`, `exportValue`, or `pattern`.

```json
{ "tool": "module", "args": { "action": "find", "props": ["getCurrentUser", "getUser"] } }
```
```json
{ "tool": "module", "args": { "action": "find", "displayName": "MessageContent", "exact": true } }
```

---

## 2. Understand the module

Before authoring, learn the module's role, real exports, and injection landmarks. Do not patch blind.

### 2a. One-call dossier — `module.explain`
Role, real exports, imports, `importedBy` count, `patchedBy`, and an intl/store/dispatch fingerprint. Always the first call after locating.

```json
{ "tool": "module", "args": { "action": "explain", "id": "451234" } }
```

### 2b. Outline without source — `module.structure`
Structural map (functions, components, returns) without dumping full source. Use to orient in a large factory before extracting.

```json
{ "tool": "module", "args": { "action": "structure", "id": "451234" } }
```

### 2c. Code around a landmark — `module.context`
Prints source surrounding a `pattern` match, `chars` on each side. This is how you eyeball the exact bytes you will write a `match` regex against.

```json
{ "tool": "module", "args": { "action": "context", "id": "451234", "pattern": "renderEmbeds", "chars": 200 } }
```

### 2d. Who consumes this module — `graph.importedBy`
Reverse dependency edges from require call-sites. High `importedBy` count = load-bearing module; a patch here has wide blast radius. Use to gauge risk and to find a narrower module upstream/downstream.

```json
{ "tool": "graph", "args": { "action": "importedBy", "id": "451234", "limit": 20 } }
```

---

## 3. Generate durable anchors — `module.genFinds`

Do not invent `find` strings by hand. `genFinds` exhaustively enumerates build-stable candidate finds for a module: it excludes `require`/`import` spans, resolves intl to `#{intl::KEY}`, ranks candidates by **durability**, and (with `requireUnique`) keeps only finds that match exactly one loaded factory.

```json
{ "tool": "module", "args": { "action": "genFinds", "id": "451234", "requireUnique": true, "minScore": 8 } }
```

Reading the output:
- **Durability tiers** rank each candidate. Prefer the highest tier: stable literal/intl-anchored strings that Discord is unlikely to rename. Lower tiers lean on minified-adjacent tokens and are more likely to rot on the next build.
- `requireUnique: true` guarantees the find is unique among currently loaded factories. If a high-durability candidate is not unique, either combine it with more context or lower to a still-durable but more specific span.
- `minScore` (default 8) drops weak sequences. Raise it to see only the strongest anchors.

Pick the highest-durability candidate that is also unique. That string becomes your patch `find`.

---

## 4. Validate before writing — `testPatch`, `patch.lint`, `patch.unique`

Never commit a patch you have not dry-run.

### 4a. Full dry run — `testPatch`
The primary gate. Give it `find` + `match` (+ optional `replace`). It validates find uniqueness, the match regex, captures, replacement preview, and post-replace syntax, and shows nearby anchors. Returns one of seven verdicts: `PASS` / `PASS_WITH_WARNINGS` / `PASS_WITH_ERRORS` / `FIND_NO_MATCH` / `FIND_NOT_UNIQUE` / `UNSAFE_PATTERN` / `MATCH_FAILED`.

```json
{ "tool": "testPatch", "args": {
  "find": "#{intl::MESSAGE_EDITED}",
  "match": "/(\\i)=(\\i)\\.editedTimestamp/",
  "replace": "$1=$self.shouldShow($2)&&$2.editedTimestamp"
} }
```
Use `\i` in `match` to mean "a minified identifier." Verdict → fix:
- `FIND_NO_MATCH` — the `find` hit **zero** modules. Widen or re-verify the literal; a stray char or a stale key gets you here. Note: `find` is searched **literally** — a `/regex/` `find` will land here. Validate regex finds via `module.find {pattern}` / `search`, never `testPatch`.
- `FIND_NOT_UNIQUE` — `find` hit >1 module. Return to step 3 for a more specific find.
- `MATCH_FAILED` — `find` was fine but the `match` regex didn't hit. Re-inspect bytes with `module.context` (step 2c).

On failure `testPatch` returns every matching module with snippets, `nearbyAnchors`, and advisory `suggestedFinds` — iterate there rather than re-running `genFinds`.

> Gotcha: `suggestedFinds` entries like `"#{intl::INBOX} + inbox-button"` are advisory anchor **combinations, not valid find syntax** (`patch.unique` on that literal → 0 hits). Combine the pieces yourself into one longer literal, or write a regex find in plugin source.

### 4b. Pattern quality score — `patch.lint`
Scores both the `find` and the `match` for brittleness (over-specific literals, anchors likely to rename). **`find` is REQUIRED** — calling with only `match` errors (`"find required"`).

```json
{ "tool": "patch", "args": {
  "action": "lint",
  "find": "#{intl::MESSAGE_EDITED}",
  "match": "/(\\i)=(\\i)\\.editedTimestamp/"
} }
```
It scores the two independently and rolls them up:
```json
{
  "find":  { "score": 9, "anchors": [...], "warnings": [], "unique": true },
  "match": { "score": 7, "anchors": [...], "matchWorks": true },
  "overallScore": 8,
  "verdict": "..."
}
```
Read `find.unique` and `match.matchWorks` together — a high `overallScore` with `unique:false` still needs a more specific find.

### 4c. Find-uniqueness check — `patch.unique`
Confirms a `find` string matches exactly one module. `str` is an alternate find field.

```json
{ "tool": "patch", "args": { "action": "unique", "find": "#{intl::MESSAGE_EDITED}" } }
```

---

## 5. Apply and prove it took effect

Write the patch into your plugin's `patches` array, then reload and verify. A patch that "compiles" is not a patch that ran.

### 5a. Reload — `reloadDiscord`
Applies patch source changes. The next tool request auto-waits for Discord to be ready.

```json
{ "tool": "reloadDiscord", "args": {} }
```

### 5b. Prove application — `patch.verifyApplied`
Per-patch `APPLIED` / `NOT_APPLIED` / `FIND_DEAD` status, a source-change check, and recent console errors for the plugin. This is the definitive "did my patch actually run" call.

```json
{ "tool": "patch", "args": { "action": "verifyApplied", "pluginName": "MessageLogger" } }
```

### 5c. Check for fallout — `console.recent`
Pull renderer errors/warnings that appeared since the reload. Use `sinceMs` to scope to just-after-reload, and `level` to filter.

```json
{ "tool": "console", "args": { "action": "recent", "level": "error", "sinceMs": 15000, "limit": 30 } }
```

### 5d. Confirm the bytes changed — `module.diff`
Shows patched vs original source for the target module, so you can read exactly what your replacement produced.

```json
{ "tool": "module", "args": { "action": "diff", "id": "451234" } }
```

---

## 6. Repair breakage after a Discord update

When a later build renames the tokens your `find`/`match` relied on, the patch silently stops applying. Diagnose and regenerate.

### 6a. Sweep all plugins — `patch.analyze`
Scans every plugin for broken (unconsumed) patches. Run this first after a Discord update to see the full damage.

```json
{ "tool": "patch", "args": { "action": "analyze" } }
```

### 6b. List unconsumed patches — `patch.broken`
Focused list of patches whose find/match no longer resolve.

```json
{ "tool": "patch", "args": { "action": "broken", "limit": 20 } }
```

### 6c. Regenerate anchors — `patch.suggestFix`
For broken patches: locates the module the stale `find` still partially matches and generates fresh, durable, unique replacement finds. Pass `match` as well to also diagnose the match regex per candidate and get back a verified adjusted `match` when repairable. Scope to one plugin via `pluginName` or one `find`.

```json
{ "tool": "patch", "args": {
  "action": "suggestFix",
  "find": "#{intl::MESSAGE_EDITED}",
  "match": "/(\\i)=(\\i)\\.editedTimestamp/",
  "pluginName": "MessageLogger"
} }
```
Take the suggested find/match back through step 4 (`testPatch`) before shipping the fix.

---

## Troubleshooting: symptom → tool

| Symptom | Reach for |
|---|---|
| Have an on-screen element, need its module | `react` `source` |
| Have visible UI copy, need its module | `intl` `search` → `intl` `targets` (never literal `resolve`/`search` — that hits the locale bundle) |
| Know a visible string, need the module | `search` (`pattern`/`patterns`) |
| `find` hits 0 modules (`FIND_NO_MATCH`) | widen / re-verify the literal; a `/regex/` find lands here (searched literally) |
| Everything on screen is a design-system primitive | pivot to the element's intl label: `intl` `search` → `intl` `targets` |
| Know a store/class/intl-key/enum, need the module | `resolve` |
| Know exports/props/displayName, need the module | `module` `find` |
| Need role, real exports, patchedBy at a glance | `module` `explain` |
| Need the factory layout before extracting | `module` `structure` |
| Need exact bytes around an injection site | `module` `context` |
| Need to gauge patch blast radius | `graph` `importedBy` |
| Need build-stable, unique find candidates | `module` `genFinds` (`requireUnique`) |
| Dry-run a find+match+replace | `testPatch` |
| Score a match regex for brittleness | `patch` `lint` |
| Confirm a find hits exactly one module | `patch` `unique` |
| Apply pending patch source | `reloadDiscord` |
| Prove a plugin's patches actually ran | `patch` `verifyApplied` |
| Check for errors after reload | `console` `recent` (`sinceMs`) |
| See patched vs original source | `module` `diff` |
| Find all broken patches after an update | `patch` `analyze` / `patch` `broken` |
| Regenerate a stale find/match | `patch` `suggestFix` |
| Find modules multiple plugins patch (conflicts) | `patch` `conflicts` |
| See all patches targeting one module | `patch` `diff` (with `id`) |
| Resolve an intl key ↔ hash while authoring | `intl` `hash` / `intl` `reverse` |
