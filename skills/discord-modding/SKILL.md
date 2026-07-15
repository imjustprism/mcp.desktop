---
name: discord-modding
description: Authoring and repairing Equicord/Vencord plugin patches against live Discord internals via the discord-dev MCP server (webpack modules, Flux, intl, React fibers on 127.0.0.1:8486).
---

# discord-modding

Author and repair Equicord/Vencord patches against a **live** Discord renderer. The MCP exposes webpack factories, Flux stores/dispatcher, the intl hash system, and the React fiber tree. Minified names are dead — you locate code by props/code/intl/CSS/pixel, not identifiers. Every patch is validated against the running build before you write a line to disk.

## Quickstart: the canonical patch-authoring loop

```
1. LOCATE  UI COPY: intl.search (text->key) -> intl.targets (key->consumer modules) is the PRIMARY path.
           STRUCT: search / resolve (string->module). react.source is LAYOUT/CHROME ONLY (pixel->module;
           usually lands on a design-system primitive — see quickstart note below).
2. DOSSIER module.explain id -> role, real exports, imports, patchedBy, intl/store fingerprint
3. FINDS   module.genFinds id -> build-stable unique find candidates (ranked, intl-resolved)
4. TEST    testPatch {find, match, replace} -> PASS | PASS_WITH_WARNINGS | PASS_WITH_ERRORS | FIND_NO_MATCH | FIND_NOT_UNIQUE | UNSAFE_PATTERN | MATCH_FAILED (iterate here, never on disk)
5. WRITE   author the patch in the plugin's definePlugin patches[] using the passing find/match/replace
6. RELOAD  reloadDiscord (next call auto-waits for ready)
7. VERIFY  patch.verifyApplied {pluginName} -> per-patch APPLIED/NOT_APPLIED/FIND_DEAD + console.recent {level:"error"}
```

Example calls (tool name + args):

```json
{"tool":"react","args":{"action":"source","selector":".message__abc12"}}
{"tool":"module","args":{"action":"explain","id":"445123"}}
{"tool":"module","args":{"action":"genFinds","id":"445123","requireUnique":true,"minScore":8}}
{"tool":"testPatch","args":{"find":"#{intl::MESSAGE_EDITED}","match":"/(\\i\\.createElement\\(\\i,\\{)(className:)/","replace":"$1foo:1,$2"}}
{"tool":"patch","args":{"action":"verifyApplied","pluginName":"MyPlugin"}}
{"tool":"console","args":{"action":"recent","level":"error","limit":30}}
```

- **UI copy is intl-first, not pixel-first.** Never `resolve`/`search` visible UI text as a literal — the top hit is the ~1.4MB locale-definition bundle (exports `default`, 0 find candidates, unpatchable by design). Route text through `intl.search {query}` -> `intl.targets {key}` (`targets` skips definition maps, returns the real consumers). Verdict `FIND_NO_MATCH` = the find hit zero modules.
- **`react.source` `nearest` is usually a design-system primitive** (Clickable/FocusRing/tooltip wrappers, importedByCount 60-230), not the feature. Reserve it for layout/chrome. Walk `stack[]` and `module.explain` each entry until importedByCount drops to feature scale; if the whole stack is primitives, pivot to the element's intl label: `intl.search <label>` -> `intl.targets`.

## Tools

| Tool | Purpose |
|------|---------|
| `module` | Webpack modules: find/extract/exports/context/diff/functionAt/structure/stats/loadLazy/watch/suggest/**genFinds**/annotate/css/**explain**. |
| `store` | Flux stores: list/find/state/call/snapshot/links (auto-resolves `User`->`UserStore`). |
| `intl` | Intl hash system: hash/reverse/search/scan/targets/recover/clearCache. Emit `#{intl::KEY}` in patches. |
| `flux` | Dispatcher + store DAG: events/listeners/dispatch/graph/producers/chain. |
| `patch` | Patch validation: unique/analyze/plugin/lint/finds/conflicts/diff/broken/suggestFix/**verifyApplied**. |
| `react` | React/DOM inspection: query/fiber/props/state/hooks/contexts/find/styles/tree/path/**source** (pixel->module). |
| `discord` | Context/utils: context/api/snowflake/endpoints/common/enum/constants/tokens/buildInfo/experiments. |
| `plugin` | Plugin mgmt: list/enable/disable/toggle/settings/setSetting. |
| `search` | Search module sources (string or `/regex/flags`); `patterns` = AND search. |
| `resolve` | Feature GPS: any landmark (intl hash / CSS class / StoreName / SCREAMING_SNAKE / literal) -> owning module(s). |
| `graph` | Dependency graph: imports/importedBy/path/neighborhood/exports (works on unloaded modules). |
| `testPatch` | Dry-run a patch: find uniqueness, match regex, captures, replace preview, post-replace syntax. |
| `evaluateCode` | Execute arbitrary JS in the renderer (last-resort, no dedicated tool). |
| `trace` | Flux action tracing: start/get/stop/store. |
| `intercept` | Intercept function calls: set/get/stop (dotted exportKey paths). |
| `console` | Renderer console ring buffer: recent/stats/clear (check after reload). |
| `batch` | Up to 10 read-only tool calls in one round-trip (mutating actions rejected). |
| `reloadDiscord` | Reload Discord; next request auto-waits for ready. |

## References

- `references/workflow.md` — the full locate->dossier->finds->test->write->verify loop with decision points and fallbacks.
- `references/finds.md` — build-stable find construction, `genFinds`/`suggest`, uniqueness, ranking, intl resolution.
- `references/patch-repair.md` — diagnosing broken patches: `patch.analyze`/`broken`/`suggestFix`/`verifyApplied`, stale finds/matches.
- `references/intl.md` — the intl hash system: hash/reverse/search/scan/recover and `#{intl::KEY}` in finds and matches.
- `references/runtime.md` — Flux (dispatcher, stores, `trace`), React fibers, `intercept`, `evaluateCode` for live inspection.
- `references/discovery.md` — finding the right module: `search`/`resolve`/`react.source`/`graph`, CSS classes, enums, experiments.
- `references/combos.md` — power combos: paste-ready batched recon recipes (module dossier, landmark->patch, store recon, trace sandwich, break-fix triage).
- `references/reference-tables.md` — per-tool output shapes (top-level fields) + latency table; consult before parsing a tool's result or nesting a registry scan in a batch.

## Rules

1. **Finds must be build-stable.** Never use module IDs, minified identifiers, or CSS hash suffixes (`_b2ca13`) as a find. They change every Discord build. Anchor on literal strings, real export props, or intl keys. `module.genFinds` exists to enumerate durable candidates — use it instead of hand-picking.
2. **Prefer `#{intl::KEY}` over raw text.** User-facing strings are intl-hashed and the hash rotates. Resolve the message to its key (`intl.search` / `resolve`) and put `#{intl::KEY}` in the find — the runtime rehashes it per build.
3. **Always `testPatch` before writing.** Iterate on find uniqueness and match regex in the dry-run tool, not on disk. A patch that isn't `PASS` will silently no-op or break at runtime.
4. **Use `\i` for minified identifiers in `match`.** Minified var/function names are unstable; write `\i` (matches a minified ident) in the regex instead of hardcoding `e`, `t`, `n`, etc. Anchor around stable literals/props, not the generated names.
5. **Verify after reload.** A patch that passed `testPatch` can still fail to apply. After `reloadDiscord`, run `patch.verifyApplied` (per-patch APPLIED/NOT_APPLIED/FIND_DEAD) and `console.recent {level:"error"}` before declaring success.
6. **Batch-first.** Every read-only call is batchable — collapse recon into one `batch` round-trip (up to 10 calls) instead of serial calls. Per-call errors are isolated, so a failing sub-call never aborts the rest. Only mutating actions (`flux.dispatch`, `plugin.toggle`, `store.call`, `module.loadLazy`, `evaluateCode`, `reloadDiscord`) must go solo.
