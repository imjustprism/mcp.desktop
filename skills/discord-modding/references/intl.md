# Discord's intl hash system

## Why this matters for patches

Discord's string localization went through a compiler: human-readable message keys like `MESSAGE_EDITED` are hashed at build time to **6 base64 characters** (`[A-Za-z0-9+/]{6}`, e.g. `"gT/06L"`). Minified webpack source never contains the key name — only the hash, referenced off the compiled messages object in two forms:

- dot form: `.t.gT06Lx` (only when the hash happens to be a valid identifier)
- bracket form: `.t["gT/06L"]` (when it contains `+`, `/`, or starts with a digit)

Minified variable names (`e`, `t`, `n`) change every Discord build, so anchoring a patch `find` on them is fatal. Intl hashes are far more stable — they only change if Discord renames or rewords the key itself. Equicord's patcher supports the placeholder **`#{intl::KEY}`**, which is expanded at patch time by running the same hash function (`runtimeHashMessageKey(KEY)` → 6 base64 chars) and matching **both** the dot and bracket forms. This makes `#{intl::KEY}` the preferred anchor for any UI string.

`#{intl::KEY}` works in **both** the `find` string and the `match` regex of a patch:

```json
{ "tool": "testPatch", "args": {
    "find": "#{intl::MESSAGE_EDITED}",
    "match": /#\{intl::MESSAGE_EDITED\}/,
    "replace": "$self.wrap($&)"
} }
```

(In actual plugin source: `find: "#{intl::MESSAGE_EDITED}"` and `match: /#{intl::MESSAGE_EDITED}/` — the placeholder is canonicalized inside regex sources too.)

> **GOTCHA — `#{intl::KEY}` in a match expands WITH its leading accessor.** Inside a `match` regex the placeholder canonicalizes to `(?:\.HASH)` (or the bracket form) **including the leading dot**. So write the access as `\i\.t#{intl::KEY}` — the `#{intl::KEY}` already supplies the `.HASH`. Writing `\.t\.#{intl::KEY}` produces a **double dot** (`.t..HASH`) → `MATCH_FAILED`. Never put a `\.` immediately before the placeholder.

### The `::raw` escape hatch

If you know only the hash (no key name recovered), `#{intl::HASH::raw}` skips hashing and uses the 6-char value literally. The `intl` tool emits this form automatically in its `find` field when no key name is known:

- key known → `find: "#{intl::SOME_KEY}"`
- key unknown → `find: "#{intl::gT/06L::raw}"`

Prefer the named form when available — it survives hash churn if Discord rebuilds, and it is self-documenting.

## The `intl` tool

Actions (verified against `tools/definitions.ts`): `hash`, `reverse`, `search`, `scan`, `targets`, `recover`, `clearCache`. Args: `action`, `key`, `hash`, `query`, `moduleId`, `limit` (default 20). Action can be inferred: `key` alone implies `hash`, `hash` alone implies `reverse`, `query` alone implies `search`.

### `hash` — key → hash

```json
{ "tool": "intl", "args": { "action": "hash", "key": "MESSAGE_EDITED" } }
```

Returns `{ key, hash, find, message, exists, warning? }`. `find` is the ready-to-use patch anchor (`#{intl::MESSAGE_EDITED}`), `message` is the live English text, `exists: false` + warning means the key hashed to something not present in Discord's loaded intl definitions (typo, or key removed). Accepts already-wrapped input like `#{intl::MESSAGE_EDITED}` and raw-hash input `#{intl::gT/06L::raw}` (the latter is resolved as a hash lookup).

### `reverse` — hash → key

```json
{ "tool": "intl", "args": { "action": "reverse", "hash": "gT/06L" } }
```

Returns `{ hash, key, find, message, exists }`. `key` is `null` when the hash isn't in the hash→key map (see `recover` below). Rejects anything that isn't exactly 6 base64 chars.

### `search` — message text → hashes

```json
{ "tool": "intl", "args": { "action": "search", "query": "edited", "limit": 10 } }
```

Case-insensitive; multi-word queries are AND-matched term-by-term. Exact-text matches sort first. Returns `{ query, count, returned, truncated?, matches: [{ hash, message, key?, find? }] }` — `key`/`find` only present when the hash is already mapped to a name. This is the usual entry point: you see a string in the UI, search it, get the hash, then `targets` to find the owning module.

> **GOTCHA — UI copy resolves to the locale bundle, not the feature. Never `resolve`/`search` visible UI text as a literal.** A literal `resolve`/`search` on the string lands on the ~1.4MB **locale-definition module** (the giant `{ "HASH": "text", ... }` map). That module `exports default`, `module.genFinds` returns **0** candidates, and it is **unpatchable by design** — a dead end. Route UI text through `intl.search {query}` → `intl.targets {key|hash}` instead: `targets` skips the definition maps and returns the **consumers** (the feature modules that render the string), which are the real patch anchors.

### `scan` — enumerate intl hashes in a module

```json
{ "tool": "intl", "args": { "action": "scan", "moduleId": "882382" } }
```

Scans that module's source for `.t.HASH`, `.t["HASH"]`, `intl.string(x.t.HASH)`, and definition-map `"HASH": [` patterns. Returns `{ moduleId, count, hashes: [{ hash, key, find, message }] }`. Use it to inventory every string a module renders — great for picking the most distinctive anchor.

### `targets` — key/hash → modules that use it

```json
{ "tool": "intl", "args": { "action": "targets", "key": "MESSAGE_EDITED" } }
```

or `{ "action": "targets", "hash": "gT/06L" }`. Searches all module factories for `.t.HASH` / `.t["HASH"]` usages. Returns `{ key, hash, message, count, modules: [...] }`. One module ≈ a unique patch anchor; many modules means you need a longer `find` combining the intl placeholder with adjacent code.

### `recover` — reconstruct key names from live messages

The static hash→key map covers only keys that appear literally somewhere (module sources, existing patch definitions, a bundled key map). Hashes outside that set reverse to `key: null`. `recover` reconstructs names for them:

```json
{ "tool": "intl", "args": { "action": "recover", "limit": 50 } }
```

How it works (`finds/intlRecover.ts`): for each unmapped hash in the currently loaded locale messages, the English message text is normalized (placeholders `{x}` / `!!{x}!!` stripped, markdown removed, uppercased, split on non-alphanumerics) into words. Candidate keys are generated from those words — the full joined string, prefixes of 2–8 words, stopword-trimmed variants (`THE/A/OF/...` removed), each also tried with common suffixes (`_LABEL`, `_TITLE`, `_TOOLTIP`, `_BUTTON`, `_PLACEHOLDER`, ... ~40 of them) and the `A11Y_` prefix — capped at 300 candidates per message. Each candidate is fed through `runtimeHashMessageKey`; **a name is accepted only if it hashes back to the exact 6-char hash**, so every recovered key is proof-checked, never guessed. (Messages like "Edited" recover `MESSAGE_EDITED`-style keys only if the real key is derivable from the text; unrecoverable hashes are remembered and skipped next time.)

Returns `{ attempted, recovered, entries: [{ hash, key, message }], persistedTotal, note }`. Real live output:

```json
{ "attempted": 1028, "recovered": 3,
  "entries": [{ "hash": "7gEVxQ", "key": "DUPLICATE_ROLE", "message": "..." }],
  "persistedTotal": 23 }
```

Recovered keys immediately resolve in `reverse`, `scan`, `targets`, and `module genFinds` output — so **run `recover` early in a session**: it improves every downstream tool's key resolution (verified +3 keys, persisted), not just `intl` itself. If you keep seeing `key: null`, this is the fix.

**Persistence** (`finds/keyMapPersist.ts`): learned keys are debounce-written to disk as a `{hash: key}` JSON map and reloaded on startup. Every reloaded entry is **self-validated against the current hash function** — entries whose key no longer hashes to its stored hash (corrupt file, stale after a Discord i18n change) are silently dropped, as are malformed hashes/keys. The store is capped at 20,000 entries. You never need to manage this file; `persistedTotal` in the `recover` result shows how many keys are learned.

### `clearCache`

```json
{ "tool": "intl", "args": { "action": "clearCache" } }
```

Drops the in-memory hash→key map (and the "recovery failed" set); next lookup rebuilds from the static map + persisted learned keys. Use after `loadLazy` pulls in modules with new key literals, or when results look stale. **`clearCache` does NOT lose recovered keys** — they were persisted to disk and reload on rebuild (and are re-proven by hashing), so `recover` output survives a cache clear.

## Related tools

- `resolve` auto-detects intl landmarks: `{ "tool": "resolve", "args": { "landmark": "gT/06L" } }` (hash) or `{ "landmark": "MESSAGE_EDITED" }` (SCREAMING_SNAKE tried as intl key among other things) — one call from string to owning module.
- `patch` / `testPatch` `find` args accept `#{intl::KEY}` directly; `patch.analyze`/`patch.plugin` probe the key and report `key_not_found` if the placeholder hashes to nothing in Discord's definitions.
- `module.explain`'s `touches.intlKeys` inventories the intl anchors a module renders, but it can contain **unrecovered `#{intl::HASH::raw}` entries and duplicates** (raw for hashes with no mapped name; dups where the same key is accessed at multiple sites). Run `intl.recover` early to convert the `::raw` forms to named keys, and de-dup the list yourself before picking an anchor.

## Typical workflow

1. See "edited" badge in UI → `intl search "edited"` → hash `gT/06L`, maybe `key: null`.
2. `intl recover` → key becomes `MESSAGE_EDITED_TIMESTAMP`-style name (proof-checked, persisted).
3. `intl targets` with that key → owning module id(s).
4. `testPatch` with `find: "#{intl::THE_KEY}"` plus a `match` regex anchored near the placeholder.
5. Ship the patch using `#{intl::THE_KEY}` in the plugin source — never the raw hash unless recovery failed (`::raw`).
