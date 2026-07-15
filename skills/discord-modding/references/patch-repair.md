# Patch Repair: Diagnosing and Fixing Broken Patches

When a Discord update breaks a patch, two independent surfaces can fail: the **find** (no longer locates a unique module) and the **match** (regex no longer fits the module's source). `patch.suggestFix` repairs both in one call. `patch.verifyApplied` proves the fix landed.

## Match failure kinds

Every match diagnosis returns a `failureKind` (from `finds/matchRepair.ts`):

| Kind | Meaning | Repairable |
|---|---|---|
| `matches` | The match regex still matches the module source as-is. Only the find is broken. | n/a. Reuse the match verbatim |
| `gap-too-narrow` | The regex structure is intact but a bounded gap `{lo,hi}` is now too small. Discord inserted code inside a span the pattern skips over. | Yes. Automatic widening. A verified `adjustedMatch` is returned |
| `lookaround-stale` | The regex fails only because a lookahead/lookbehind asserts context that no longer exists around the anchor. | Yes. Stale lookaround(s) stripped, verified `adjustedMatch` returned |
| `literals-missing` | One or more literal runs (>=4 chars) from the pattern no longer appear in the source. The anchored code was renamed or removed. | No. Rewrite by hand. `missingLiterals` names the dead anchors |
| `structure-changed` | All literals still exist in the source but the regex still fails. The code between/around them was reordered or rewritten. | No. Re-derive the match from fresh source (`module.context` / `module.functionAt` around a surviving literal) |

`\i` in patterns expands to the minified-identifier class `(?:[A-Za-z_$][\w$]*)` before any matching, same as Vencord's canonicalizer.

## How automatic repair works

Diagnosis runs in strict order: direct match, gap widening, lookaround stripping, literal triage.

### Gap widening (`gap-too-narrow`)

Only bounded quantifiers of the exact form `{lo,hi}` whose atom is a single char/class are candidates. Quantifiers on a group `(...){0,5}` or on `\i` are never touched. Patterns with more than **8** bounded quantifiers are not attempted.

1. **Single-gap pass:** for each quantifier in turn, probe with its `hi` raised to **MAX_GAP = 1000**. If that matches, binary-search the minimum `hi` that still matches, then add **10 slack** (capped at 1000). First quantifier that succeeds wins. A per-quantifier step budget (**MAX_WIDEN_STEPS = 200,000**) skips quantifiers whose combined search space is too large.
2. **Uniform multi-gap pass** (fallback, needs >=2 quantifiers): raise *all* quantifiers to one uniform `hi`, bounded by a total budget (**MULTI_WIDEN_BUDGET = 50,000,000** chars, divided by source length, nth-rooted across the gap count, capped at 1000). Binary-search the minimal uniform value, add 10 slack.

Widened repairs return `adjustmentNote` like `"widened a bounded gap to the minimum that still matches"`. The result is re-minimized, so the adjusted pattern stays tight and will not swallow unrelated code. Real live result shape:

```json
{ "status": "repaired", "failureKind": "gap-too-narrow",
  "adjustedMatch": "...\\).{0,55})...",
  "note": "widened a bounded gap to the minimum that still matches" }
```

(observed restoring the exact original bound after a `{0,5}` mangle).

### Lookaround stripping (`lookaround-stale`)

Lookarounds are removed cumulatively from last to first. A stripped candidate is accepted only if **all three** hold:

1. it matches the source,
2. it still contains a literal anchor (a literal run of >=2 chars). A pattern reduced to pure wildcards is rejected,
3. the stripped pattern matches the source **exactly once**. If stripping makes it ambiguous (>=2 matches), repair aborts entirely rather than hand you a match that could hit the wrong site.

**Capture-safety guarantee.** If a stale lookaround being stripped *contains a capturing group*, repair refuses that candidate outright (`hasCapturingGroup` returns `null`, `status:"unrepaired"`). Removing it would delete a `(...)` and shift every subsequent `$n` reference in the `replace`. An `adjustedMatch` therefore **never silently changes capture numbering**. You get either a repair that preserves all captures or an unrepaired verdict you must fix by hand. Repairs that strip only zero-width `(?=...)`/`(?<=...)` assertions (no captures inside) are safe and proceed.

### Safety budgets (why repairs degrade instead of hang)

All numeric limits are hard caps: MAX_GAP 1000, quantifier count cap 8, single-gap step budget 200k, multi-gap budget 50M source-chars, literal-run minimum 4 chars for triage. When a budget is exceeded the repair reports `status: "unrepaired"` with the best `failureKind` it could determine. It never spins.

Repair result fields: `status` (`matches` / `repaired` / `unrepaired`), `failureKind`, `adjustedPattern`/`adjustedMatch` + `adjustmentNote` when repaired, `foundLiterals`, `missingLiterals`, `matchIndex`.

## patch.suggestFix

Locates the module a stale find *used to* point at, generates fresh durable unique replacement finds, and (if `match` is passed) runs the diagnosis above per candidate.

Targets: pass `find` for one stale find, or omit it to scan every plugin's plain-string finds that currently match zero modules (optionally narrowed with `pluginName`, substring match. `limit` caps targets, default 10, max 50). Regex finds are skipped in scan mode.

### Candidate discovery order (up to 3 candidate modules per broken find)

1. **Intl-hash probes**, highest confidence. Hashes are extracted from `#{intl::KEY}` templates in the raw find and from 6-char hash-shaped tokens in the canonicalized find (verified against the reverse hash map). Modules containing `.t.HASH` or `.t["HASH"]` are collected. Intl hashes survive minifier churn, so a hit here is almost certainly the right module.
2. **Full-find probe**, the canonicalized find string searched as a plain substring (catches finds that broke only via `#{intl::}` canonicalization drift).
3. **Fragment / match-literal intersection ranking**. The canonical find is split on punctuation into fragments (>=6 chars). If `match` was provided, its literal runs (>=5 chars) are added as probes. Up to 12 probes are scanned (probes hitting 0 or >=25 modules are discarded as useless/too-common). Modules hit by **>=2** distinct probes are ranked by intersection count. If nothing intersects, the single narrowest probe result is used only when it names <=5 modules.

### Reading the output

Each suggestion: `{ plugin?, brokenFind, targetCandidates: [...] }`. Each candidate:

- `moduleId`, `hint`. The module and a human hint of what it is.
- `suggestedFinds`. Up to 3 fresh finds from the exhaustive generator, **filtered to those matching exactly one loaded module**, each with `durability` and `tier`. Prefer the highest-durability entry.
- `matchRepair`. Only when you passed `match`: `{ status, failureKind, adjustedMatch?, note?, missingLiterals? }` per the table above. `adjustedMatch` is already verified against that candidate's source. Use it directly.
- Candidates with neither a unique find nor a matchRepair are dropped.

**Gotcha: multiple candidates can EACH report `status:"repaired"`.** The `match` is diagnosed *per candidate*, so different modules widen to different bounds (observed live: the right module widened its gap to `{0,55}`, a wrong module widened the same gap to `{0,319}`). The candidate list is ranked but **not exclusive**. An `adjustedMatch` on a wrong module is still a real match against *that* module's source, just not your patch target. Always confirm the module is correct via its `hint` (and `module.explain` if unsure) **before** adopting its `adjustedMatch`. Do not blindly take the first `repaired` entry.

Top-level `matchWarning` appears when the `match` arg could not be parsed as a regex (pass `/pattern/flags` or a plain regex body). matchRepair is then skipped, not errored.

### Examples

Find only (locate module + fresh finds):

```json
{ "tool": "patch", "args": { "action": "suggestFix", "find": "#{intl::MESSAGE_EDITED}" } }
```

Find + match (also diagnose/repair the regex per candidate):

```json
{
  "tool": "patch",
  "args": {
    "action": "suggestFix",
    "find": ".Messages.MESSAGE_EDITED",
    "match": "/edited:(\\i)\\.editedTimestamp,.{0,30}children:\\[/"
  }
}
```

Scan one plugin's broken finds:

```json
{ "tool": "patch", "args": { "action": "suggestFix", "pluginName": "betterInvites", "match": "/\\.guild\\.features\\.has\\((\\i)\\)/" } }
```

### Limitation: find-only can't locate a single-token find with an in-token typo

Discovery probes are **exact fragments** split on punctuation (`>=6` chars). It never fuzzy-matches. A stale find that is one unbroken token with a typo *inside* the token (e.g. a renamed method with no surrounding punctuation) produces zero usable probes, so `targetCandidates` is empty. Manual fallback chain:

1. `search` (or `module.find {code}`) with a **surviving prefix** of the old find, the part before the drift point.
2. Failing that, run `patch.broken` and read the broken entry's **`partialMatch.modules`**, then feed each module to `module.genFinds` to synthesise a fresh unique find by hand.

### `patch.broken`'s `partialMatch` field, the manual-repair seed

When `patch.broken` reports a find matching zero modules, it splits the canonicalized find into fragments and reports the first fragment that still hits any module:

```json
"partialMatch": { "fragment": "MessageReactions", "modules": ["956703"] }
```

(real live entry: RoleColorEverywhere's `MessageReactions.render:` find, fragment `MessageReactions`, module `956703`.) This is the single most actionable field for manual repair. It names the module the stale find *drifted off of*. Pipe `partialMatch.modules` straight into `module.genFinds` to regenerate a durable unique find. `partialMatch` is absent when the find matched modules (the `reason` is then "replacements had no effect or errored", not a dead find).

## patch.verifyApplied

Proves a plugin's patches took effect at runtime. Run this after editing a patch and reloading.

```json
{ "tool": "patch", "args": { "action": "verifyApplied", "pluginName": "KeywordNotify" } }
```

Top-level shape: `{ plugin, enabled, patchCount, applied, verdict, note?, ambientConsoleErrorsLast2Min, ambientErrorsNote?, recentErrors?, patches: [...] }`.

**`enabled` gate (check this first).** `enabled` reflects `plugin.started`. A **disabled** plugin never registers its patches, so every patch reads `NOT_APPLIED`, which is expected, not breakage. The tool surfaces this as its own verdict rather than a false INCOMPLETE: when `enabled` is `false` the verdict is `PLUGIN_DISABLED` and `note` explains the NOT_APPLIED rows are benign. Enable the plugin and reload before treating any per-patch status as a real signal.

Per-patch `status`:

| Status | Meaning | Next step |
|---|---|---|
| `APPLIED` | Find hits exactly one module, this plugin is in its patchedBy list, and the module's patched source differs from the original. | Done for this patch |
| `NOT_APPLIED` | Find hits a module but this plugin never patched it (match likely failed at patch time, or the plugin is disabled). | Diagnose the match: `suggestFix` with `find` + `match`, or `testPatch` |
| `CONSUMED_NO_CHANGE` | Plugin patched the module but the source is byte-identical. The replacement was a no-op (e.g. replace equals match, or a capture reproduced the original text). | Fix the `replace` string |
| `FIND_DEAD` | Find matches zero modules. | `suggestFix` for a fresh find |
| `FIND_AMBIGUOUS` | Find matches >1 module (scan stops at 3). | Tighten the find. Validate with `patch.unique` or `testPatch` |

Each patch result includes the matched `modules` array (`moduleId`, `appliedByThisPlugin`, `sourceChanged`, `patchedBy`, the last exposing which *other* plugins also patched it, useful for conflict triage via `patch.conflicts`).

### Top-level verdict

`verdict` is one of exactly four values, decided purely from patch state (console errors do **not** move it):

- `PLUGIN_DISABLED`. `enabled` is `false`. Per-patch NOT_APPLIED rows are expected. Enable + reload, then re-run.
- `NO_PATCHES`. The plugin declares zero patches.
- `ALL_APPLIED`. Every patch is `APPLIED`. The patches landed. (Named `ALL_APPLIED`, *not* `ALL_APPLIED_CLEAN`. Console cleanliness is reported separately, see below.)
- `INCOMPLETE`. At least one patch is not APPLIED. Check per-patch statuses and `suggestFix` the broken ones.

### Ambient console errors (weak signal, NOT attributed to this plugin)

The response also reports renderer errors from the **last 2 minutes**: `ambientConsoleErrorsLast2Min` (count), `ambientErrorsNote`, and `recentErrors` (last 5 error texts, truncated to 160 chars). These errors are **AMBIENT**. They come from any plugin/tool in the renderer and are **not** attributed to this plugin's patches, so they never change the `verdict`. Treat them only as a weak follow-up signal. A syntactically-applied patch *can* still throw at runtime, so if `ALL_APPLIED` coincides with fresh errors, inspect `recentErrors` and pull more via `console` `{ "action": "recent", "level": "error" }`. Do not assume the errors are yours.

## Standard repair loop

1. `patch.plugin` or `patch.broken`. Identify which patches are broken.
2. `patch.suggestFix` with `find` (and `match` when the match may also be stale). Get the target module, a fresh unique find, and a verified `adjustedMatch` if repairable.
3. If `failureKind` is `literals-missing` / `structure-changed`: pull fresh source with `module.context` / `module.functionAt` around a `foundLiterals` anchor and rewrite the match. Validate with `testPatch`.
4. Edit the plugin source, rebuild, `reloadDiscord`.
5. `patch.verifyApplied` with `pluginName`. Require verdict `ALL_APPLIED` (and confirm `enabled:true`. If `recentErrors` is non-empty, sanity-check they aren't from your patch, but they don't gate the verdict).
