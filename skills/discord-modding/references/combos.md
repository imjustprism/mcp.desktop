# Power Combos

`batch` runs up to **10 read-only tool calls in one round-trip**, with **per-call errors isolated** (a bad sub-call doesn't sink the rest). Mutating actions — `flux.dispatch`, `plugin.toggle`, `store.call`, `module.loadLazy`, `evaluateCode` — are rejected per-call, so keep them out of batches. **Batch-first is the default recon posture:** everything read-only is batchable, so fan out lookups rather than serializing them.

All timings below are from a live Discord Canary eval (warm registry). Cold caveat: the **first store/flux call after startup pays ~2s** index-build; `patch.broken`/`patch.conflicts`/`patch.analyze` are whole-registry scans (~2–4.5s) — never nest those in a latency-sensitive batch.

---

### 1. Module dossier — ~130ms
You hold a module ID and want everything about it in one shot.
```json
{"tool":"batch","args":{"calls":[
  {"tool":"module","args":{"action":"explain","id":"803921"}},
  {"tool":"module","args":{"action":"structure","id":"803921"}},
  {"tool":"module","args":{"action":"genFinds","id":"803921","requireUnique":true}},
  {"tool":"graph","args":{"action":"importedBy","id":"803921"}}
]}}
```
Yields role, real exports, patchedBy, function map, ranked unique finds, and blast radius. **Default move whenever you hold a module ID.**

---

### 2. Landmark → verified patch — 3 trips, ~300ms
From an observable landmark to a `PASS`-tested patch.
```json
{"tool":"resolve","args":{"landmark":"MESSAGE_EDITED"}}
```
then a dossier batch on the winning module:
```json
{"tool":"batch","args":{"calls":[
  {"tool":"module","args":{"action":"explain","id":"<id>"}},
  {"tool":"module","args":{"action":"genFinds","id":"<id>","requireUnique":true}},
  {"tool":"module","args":{"action":"context","id":"<id>","pattern":"editedTimestamp"}}
]}}
```
then `testPatch`. **For visible UI copy, replace trip 1 with `intl.search{query}` → `intl.targets{key}`** — a literal `resolve` of UI text lands on the ~1.4MB locale bundle (dead end; unpatchable by design).

---

### 3. Store recon — ~90ms warm (~2s on first call after startup)
Full picture of a Flux store's surface and live state.
```json
{"tool":"batch","args":{"calls":[
  {"tool":"store","args":{"action":"find","name":"TypingStore"}},
  {"tool":"flux","args":{"action":"graph","store":"TypingStore"}},
  {"tool":"store","args":{"action":"links","name":"TypingStore"}},
  {"tool":"store","args":{"action":"snapshot","name":"TypingStore"}},
  {"tool":"resolve","args":{"landmark":"TypingStore"}}
]}}
```
API surface, handled actions + dependsOn/dependents DAG, sync partners + subscriber counts, live state, and module id. Note `snapshot` only invokes **zero-arg getters** (typically 2–3 even when `find` lists 20+ methods); `resolve` on a StoreName returns the module under `referencingModules` (empty `definingModules` is normal).

---

### 4. Trace sandwich
Capture dispatched actions while you do other recon in the same window.
```json
{"tool":"trace","args":{"action":"start","filter":"TYPING","duration":10000}}
```
Run other recon batches in-window, then:
```json
{"tool":"trace","args":{"action":"get","id":1}}
{"tool":"trace","args":{"action":"stop","id":1}}
```
Captures are `{ts,type[,data]}` + `typeCounts` — the action payload (everything but `type`) is included as `data` when it is non-empty; for a function's args and return values use the `intercept` tool instead. **Auto-expiry discards captures** — always `get` before the window closes; `stop` inside the window returns final results. When you know when to reach: mapping which actions fire during a live interaction.

---

### 5. Break-fix triage — ~150ms
A plugin's patches broke and you want the fresh finds.
```json
{"tool":"batch","args":{"calls":[
  {"tool":"patch","args":{"action":"plugin","pluginName":"RoleColorEverywhere"}},
  {"tool":"patch","args":{"action":"plugin","pluginName":"BetterInvites"}}
]}}
```
then, per broken find, diagnose with `suggestFix` — **always pass `match`** so it verifies an adjusted match per candidate:
```json
{"tool":"patch","args":{"action":"suggestFix","find":"MessageReactions.render:","match":"/(\\i)\\.render/"}}
```
Empty `targetCandidates`? Fall back to `patch.broken` → its `partialMatch.modules` → hand those to `module.genFinds`. Note `suggestFix` candidates are ranked but **not exclusive** (multiple modules can each return a "repaired" match) — confirm the module via `hint`/`explain` before adopting an `adjustedMatch`.

---

### 6. testPatch as repair loop
Don't re-run `genFinds` on a failed patch — iterate inside `testPatch`.
```json
{"tool":"testPatch","args":{"find":"#{intl::MESSAGE_EDITED}","match":"/(\\i)=(\\i)\\.editedTimestamp/","replace":"$1=$2.editedTimestamp"}}
```
On failure it returns every matching module with snippets, `nearbyAnchors` (uniqueness + byte distance), and advisory `suggestedFinds` — refine the find right there. Verdicts (7): `PASS | PASS_WITH_WARNINGS | PASS_WITH_ERRORS | FIND_NO_MATCH | FIND_NOT_UNIQUE | UNSAFE_PATTERN | MATCH_FAILED`. `testPatch`'s `find` does **not** accept `/regex/` form (validate regex finds via `module.find{pattern}` / `search` instead).
