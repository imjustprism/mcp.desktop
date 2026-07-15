# Find Generation & Durability

`module.genFinds` tokenizes a webpack module's source and emits candidate `find` strings for `findByCode` / patch `find:` fields, ranked by how likely they are to survive Discord rebuilds. Use it instead of hand-picking substrings.

## Tool call

```json
{ "tool": "module", "args": { "action": "genFinds", "id": "455629" } }
```

With options:

```json
{ "tool": "module", "args": { "action": "genFinds", "id": "455629", "requireUnique": true, "minScore": 8, "limit": 20 } }
```

- `id` (required): module ID.
- `minScore` (default 8): minimum sequence score — length/entropy weight of the token run, NOT durability. Raise it to only get longer, more distinctive anchors.
- `requireUnique` (default false): drop any find that matches more than one loaded module factory.
- `limit` (default 20, max 200): max finds returned.

## Output shape

```json
{
  "id": "455629",
  "sourceSize": 18240,
  "candidateCount": 143,
  "uniqueCount": 12,
  "uniquenessScope": "loaded-factories",
  "finds": [
    {
      "find": "#{intl::GUILD_SETTINGS_ROLES}",
      "type": "intl",
      "tier": "intl",
      "score": 29,
      "durability": 10,
      "unique": true,
      "moduleCount": 1,
      "reason": "anchored on an intl key (#{intl::KEY}) — content-independent, stable per key name",
      "regex": false
    }
  ]
}
```

Field meanings:

- `find` — the literal string (or regex source when `regex: true`) to use as `find:` in a patch or `findByCode(...)` arg.
- `type` — `"intl"` (synthesized `#{intl::KEY}` placeholder), `"sequence"` (contiguous token run from the source), `"pair"` (two runs joined by a bounded-gap regex; always `regex: true`).
- `tier` / `durability` — see durability tiers below. `durability` is 0–10.
- `score` — distinctiveness weight (token length × log entropy). Bigger = more content, less likely to collide. **`score` is the raw sequence weight, NOT the rank key** — genFinds ranks by durability, not score. A short intl find (low score) outranks a long weak sequence (high score). Don't sort candidates by `score` yourself.
- `unique` / `moduleCount` — whether the find matched exactly one **loaded** factory, and how many it matched. `unique: true` with `moduleCount: 1` is what you want.
- `reason` — the primary durability rationale/warning.

Sorting: unique first, then durability desc, then score desc. Pick the top unique find; prefer `tier: "intl"` or `"storeName"` when available.

## Durability tiers

Scored by `scoreDurability` (0–10, base assigned by tier, then penalties subtracted):

| Tier | Base score | Anchor | Why stable / fragile |
|---|---|---|---|
| `intl` | **10** | `#{intl::KEY}` placeholder | Content-independent: Equicord resolves the key to the current per-build hash at patch time. Survives copy edits and hash rotation; only breaks if Discord deletes/renames the key. |
| `intl` (raw) | 5 | raw 6-char intl hash (`.t.AbC123`) | The hash changes whenever the English copy changes. Always convert to `#{intl::KEY}` form instead. |
| `storeName` | **8** | Flux store display-name literal (`"GuildMemberStore"`) | Store names are hand-written API surface, referenced across the codebase; essentially never renamed by minification or rebuilds. |

Live `storeName` exemplar (TypingStore, verified): genFinds emits `find: ")}static displayName=\"TypingStore\";getTypingUsers("` — `tier: "storeName"`, `durability: 8`, `unique: true`. Note the anchor is the `static displayName="..."` literal, not just the bare name; genFinds bundles the surrounding structure so the run stays unique.
| `errorString` | **7** | multi-word string literal ≥8 chars (error/log copy) | Developer-facing copy is not minified and rarely edited — but it CAN be reworded, unlike intl keys. |
| `string` | **6** | short string literal (no whitespace) | Literals survive minification, but short single-word strings are more likely to appear in other modules and to be refactored. |
| `method` | **6** | method name ≥5 chars (`.getChannel(`) | Public-ish method names survive minification (only local idents get mangled), but internal renames happen. |
| `prop` | **5** | property name ≥4 chars (`autocomplete:`) | Property keys survive minification, but object shapes get reordered/restructured more freely than call sites. |
| `weak` | 5 base, no anchor bonus | none | No intl key, store name, or distinctive string — pure structure/idents, expected to drift every build. |

## Volatility penalties

Subtracted from the tier base (never applied to `#{intl::KEY}` finds):

- **Multi-digit numbers** (3+ digits): −2 each, capped at −4. These are usually module/chunk ids, which are reassigned on every build. (Skipped for `errorString` tier — numbers inside prose copy are fine.)
- **CSS hash suffix** (`name_ab12cd` shape): −3. The suffix after `_`/`-` is a per-build content hash. Match the logical prefix (`name_`) instead, or use `module.find` with `className`.
- **16+ char hex hash**: −3. CDN asset / content hashes rotate whenever the asset or build changes.
- **3+ one/two-char identifiers**: −2. Minified names are re-rolled every build — put `\i` in the patch `match`, never in the `find`.
- **Plain-English copy** (weak/string tiers only): −1. Marketing/UI wording rots when Discord edits it; if an intl key exists for that copy, use it.
- **Very short** (<8 chars excluding intl placeholders): −1. Higher risk of matching the wrong module after a rebuild.

Rule of thumb: durability ≥8 is a "set and forget" find; 6–7 will occasionally break on copy edits; ≤5 should only ship if nothing better is unique — and then prefer a pair find.

## What genFinds excludes (and why)

Candidates are token runs; a run is cut whenever it hits:

- **require/import spans** — `n(12345)`, `n.n(e)`, `n.t(123)`, `n.e("chunkId")`, `n.bind(n, 123)`, and whole `var a=n(123),b=n(456);` chains (the require param is auto-detected from the module header). Module ids inside these are reassigned every build, so any find containing them dies immediately.
- **`webpackId: 123` spans** — same reason: raw module ids.
- **identifiers ≤4 chars** — treated as minified; they are renamed per build, so a run breaks at each one. Only idents ≥5 chars survive into finds.
- Lone punctuation / lone declaration keywords, runs with no content token (ident/string/template/regex), runs scoring below `minScore`, and finds over 400 chars.

This is why generated finds sometimes look like disjoint fragments of the source — everything build-volatile has been carved out.

**Aside — `module.structure` `keyStrings`:** if you use `module.structure` to eyeball anchors before genFinds, note its `keyStrings` array includes **bare numeric strings** (e.g. `"455629"`) that are webpack module ids pulled from require sites, not semantic anchors. Never lift those into a find — they're reassigned every build. genFinds already carves them out; trust its output over raw `keyStrings`.

## Pair synthesis (`type: "pair"`)

When no single sequence is unique, the tool automatically synthesizes **pair finds**: two stable fragments joined by a bounded gap regex, e.g.

```
getChannel\(this\.props[\s\S]{0,34}"MessageActionCreators"
```

- Emitted as `regex: true` — use it as `find: /.../ ` (regex), not a plain string.
- The gap bound is the observed gap + 10 chars of slack, so minor code shuffles between the anchors still match, but a gap explosion (real refactor) correctly fails.
- Pair durability = `min(left, right) − 1`; the tier reported is the weaker fragment's tier.
- Pairs only appear in output when no non-pair find was unique — you don't need to request them.

### Validating a pair (regex) find — do NOT use testPatch

Pair finds are `regex: true`, and **the `testPatch` tool's `find` arg is a plain string that is treated literally** — it does not accept `/regex/` form (see `tools/definitions.ts`: `find: { type: "string" }`). Feed a pair find into `testPatch` and the regex source is searched as a literal string, hits zero modules, and you get verdict `FIND_NO_MATCH` even though the find is correct. Validate regex/pair finds with `module.find` `{pattern}` (or the `search` tool) instead — both accept `/regex/flags`:

```json
{ "tool": "module", "args": { "action": "find", "pattern": "getChannel\\(this\\.props[\\s\\S]{0,34}\"MessageActionCreators\"", "all": true } }
```

Confirm exactly one match, then ship the pair as the plugin's `find:`. Reserve `testPatch` for plain-string finds paired with a `match`.

## uniquenessScope caveat: loaded-factories only

`unique` / `moduleCount` are computed against **currently loaded webpack factories** (`uniquenessScope: "loaded-factories"`) — this is confirmed live: `unique: true` means unique among loaded factories *only*. A find that genFinds reports as `"unique"` can still collide with a module inside a lazy chunk that hasn't been fetched yet — your patch would then apply to the wrong module (or both) once that chunk loads. `unique: true` is never a global guarantee.

For lazy-heavy surfaces (settings pages, modals, dev tools, activities, less-visited routes), force the chunks in first:

```json
{ "tool": "module", "args": { "action": "loadLazy" } }
```

then re-run `genFinds`. If uniqueness holds after `loadLazy`, trust it. Also sanity-check the final find with `module.find` + `pattern` and `all: true` to confirm exactly one hit.
