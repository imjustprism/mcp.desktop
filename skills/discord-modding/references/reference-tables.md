# Reference Tables

Dense lookup tables to consult mid-task. All figures from a live Discord Canary eval (Equicord 1.14.15.2). Verify action/arg names against `tools/definitions.ts` before use.

## Latency (budget your batches)

| Class | Tools / actions | Warm latency |
|---|---|---|
| Pure lookups | `module.find`/`context`, `graph.imports`/`importedBy` (reverse), `resolve`, `store.state` | 30–180ms |
| Find generation | `module.genFinds` | 120–260ms |
| Fix probing | `patch.suggestFix` | ~40ms per target |
| Source shaping | `module.explain`, `module.structure` | 90–290ms |
| Registry scans | `patch.broken`, `patch.conflicts`, `patch.analyze` | 2–4.5s (whole-registry) |
| Cold index build | first `store.*` / `flux.*` call after startup | ~2s once; 30–300ms warm after |

Rules: everything read-only is `batch`-able (per-call errors isolated, up to 10 calls/round-trip). Never nest a registry scan inside a latency-sensitive batch. The first store/flux touch of a session pays a one-time ~2s index cost — do it early.

## Verdict / status enums

### `testPatch` verdict (7 values)

| Verdict | Meaning |
|---|---|
| `PASS` | find unique, match + captures + replacement all valid, no warnings |
| `PASS_WITH_WARNINGS` | find unique + match applied, but non-fatal warnings present |
| `PASS_WITH_ERRORS` | find unique + match applied, but error-severity warnings present (e.g. post-replace syntax error, invalid capture ref) |
| `FIND_NOT_UNIQUE` | find hit >1 module |
| `FIND_NO_MATCH` | find hit ZERO modules (also what you get if you pass a `/regex/` — testPatch searches the find literally) |
| `UNSAFE_PATTERN` | match has catastrophic-backtracking risk; match not evaluated |
| `MATCH_FAILED` | find OK but the match regex did not apply |

Validate regex finds via `module.find {pattern}` or `search`, never testPatch.

### `patch.verifyApplied`

| Per-patch status | Meaning |
|---|---|
| `APPLIED` | patch took effect |
| `NOT_APPLIED` | did not take effect |
| `CONSUMED_NO_CHANGE` | matched + consumed but produced no source change |
| `FIND_DEAD` | find no longer matches any module |
| `FIND_AMBIGUOUS` | find matches multiple modules |

| Overall status | Meaning |
|---|---|
| `ALL_APPLIED` | every patch applied |
| `INCOMPLETE` | some patches not applied |
| `PLUGIN_DISABLED` | plugin off — nothing to verify |
| `NO_PATCHES` | plugin defines no patches |

### `patch.suggestFix` — matchRepair

| `failureKind` | Meaning |
|---|---|
| `matches` | match still works (no repair needed) |
| `gap-too-narrow` | a bounded gap `{0,N}` is too small — widen |
| `lookaround-stale` | a lookaround no longer matches |
| `literals-missing` | literal tokens gone from source |
| `structure-changed` | surrounding structure changed shape |

| `status` | Meaning |
|---|---|
| `matches` | unchanged, still valid |
| `repaired` | produced an `adjustedMatch` |
| `unrepaired` | could not safely repair (e.g. refused to strip a stale lookaround containing a capturing group — capture-safe guarantee) |

### Find durability tiers (`genFinds` `tier` → `durability`)

| Tier | Durability | Notes |
|---|---|---|
| `intl` | 10 | `#{intl::KEY}` — content-independent, most stable |
| `storeName` | 8 | `static displayName="XStore"` — survives rebuilds |
| `errorString` | 7 | thrown/log error literals |
| `string` | 6 | other string literals |
| `method` | 6 | method-name anchors |
| `prop` | 5 | property-access anchors |
| `weak` | (lowest) | minified-var-adjacent; avoid |

## Output shapes (highest-variance tools)

### `resolve` — shape VARIES by auto-detected landmark type

| Detected type | Trigger | Top-level fields |
|---|---|---|
| `symbol` | SCREAMING_SNAKE (intl key / action type / enum member) | `{type:"symbol", asIntlKey:{hash, modules:[...]}, asActionType?, asEnumKey?}` |
| `store` | StoreName / displayName | `{type:"store", definingModules:[] (empty is NORMAL), referencingModules:[{id, hint:"XStore (store)"}]}` — the module you want is in `referencingModules` |
| `cssClass` | 6-hex suffix / hashed class | `{type:"cssClass", suffix, classMapModules:[{id, hint, classNames}]}` |
| `literal` | any plain string, incl. 5-char CSS suffix like `guilds__5e434` (falls back to literal — finds the consumer, not the CSS module; use `module.find {className}` instead) | `{type:"literal", modules:[...]}` |

Never `resolve` visible UI copy as a literal — the top hit is the ~1.4MB locale bundle (unpatchable). Route UI text `intl.search` → `intl.targets`.

### `module.genFinds`

```
{ id, sourceSize, candidateCount, uniqueCount, uniquenessScope, finds:[{find,type,tier,score,durability,unique,moduleCount,reason}] }
```
Exemplar (TypingStore): `find:")}static displayName=\"TypingStore\";getTypingUsers("`, tier `storeName`, durability 8, unique.

### `patch.suggestFix`

```
{ count, note, matchWarning?, hint?, suggestions:[{ plugin?, brokenFind, targetCandidates:[{moduleId, hint, suggestedFinds:[{find,durability,tier}], matchRepair:{status,failureKind,adjustedMatch,note}}] }] }
```
Candidates are ranked but NOT exclusive — multiple modules can each report `status:"repaired"` (observed: right module widened `{0,55}`, a wrong one `{0,319}`). Confirm the module via `hint`/`module.explain` before adopting an `adjustedMatch`. Empty `targetCandidates`? → `patch.broken` `partialMatch.modules` → `module.genFinds` by hand. Find-only mode can't locate single-token finds with in-token typos (probes are exact ≥6-char fragments split on punctuation).

### `module.explain`

```
{ role, publicExports, imports, importedByCount, patchedBy, touches:{ intlKeys, stores, dispatches } }
```
`touches.intlKeys` may contain unrecovered `#{intl::HASH::raw}` entries + duplicates — run `intl.recover` early in a session (persists learned keys) to clean downstream output.

### `module.css`

```
{ totalIndexed, count, matches:[{moduleId, hash, classCount, matchingClasses:{localName:renderedClass}}] }
```
Query with a RENDERED hashed class (`wrapper_ef3116`), not a semantic name — `{className:"embedWrapper"}` returns `count:0` live.
