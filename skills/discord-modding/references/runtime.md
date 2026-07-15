# Live Runtime Introspection

Tools for inspecting the *running* Discord renderer: the React tree, Flux stores, the dispatcher, live function calls, and the console. Use these when static source reading (search/module/graph) isn't enough — when you need to know what a component actually rendered, what a store currently holds, or what fired when the user clicked.

All examples below are literal MCP tool calls: `tool` name + `args` object. Actions and arg names are exactly as defined in `definitions.ts`.

---

## react — React/DOM inspection & pixel-to-source bridging

Inspect the live React fiber tree and DOM. Actions: `query`, `styles`, `tree`, `path`, `fiber`, `props`, `hooks`, `contexts`, `find`, `state`, `source`.

### react.query — locate on-screen elements
```json
{ "tool": "react", "args": { "action": "query", "selector": "[class*='chatContent']", "includeText": true, "limit": 10 } }
```

### react.fiber — component tree around a node
`direction` `up` (ancestors) or `down` (descendants); `depth` bounds traversal; `includeProps` attaches prop snapshots.
```json
{ "tool": "react", "args": { "action": "fiber", "selector": "[class*='message__']", "direction": "up", "depth": 8, "includeProps": true } }
```

### react.props — props of the component at a selector
```json
{ "tool": "react", "args": { "action": "props", "selector": "[class*='panels__']" } }
```

### react.hooks — hook state of a component (order-indexed useState/useRef/etc.)
```json
{ "tool": "react", "args": { "action": "hooks", "selector": "[class*='chatInput']" } }
```

### react.source — THE pixel-to-source bridge
Maps a rendered element to its owning webpack module(s), export name, a role hint, and which plugins already patch it. This is the primary way to go from "this thing on screen" to "the module + anchor I patch". Start patch authoring here.
```json
{ "tool": "react", "args": { "action": "source", "selector": "[class*='userPopout']" } }
```
Returns module IDs, export name, hint, and `patchedBy`. Feed the module ID into `module.explain` / `module.genFinds` and the export into your `find`.

- **`nearest` is usually a design-system primitive, not your feature.** Clickable/FocusRing/tooltip wrappers show `importedByCount` 60–230 (`graph.importedBy` / `module.explain`). Walk `stack[]` and `module.explain` each entry until `importedByCount` drops to feature scale (single/low digits). If the entire `stack[]` is primitives, pivot to the element's intl label instead: `{tool:"intl",args:{action:"search",query:"<visible label>"}}` → `{tool:"intl",args:{action:"targets",key:"<KEY>"}}` (targets returns the real consumers). Layout/chrome elements are the only reliable `react.source` wins — for feature code, prefer intl-first discovery.

Other actions: `styles` (computed CSS; pass `properties` array to narrow), `tree` (DOM subtree), `path` (selector for a node), `contexts` (context providers above a node), `find` (by `componentName` / props), `state` (class-component state).

---

## store — Flux store data

Auto-resolves shorthand: `"User"` → `UserStore`. Actions: `find`, `list`, `state`, `call`, `snapshot`, `links`.

### store.find — methods/getters/props of a store (`method` filters the listing)
```json
{ "tool": "store", "args": { "action": "find", "name": "GuildMember", "method": "getMember" } }
```

### store.state — read a getter/value
```json
{ "tool": "store", "args": { "action": "state", "name": "User", "method": "getCurrentUser" } }
```

### store.call — invoke a store method with args (MUTATING-CLASS — rejected by batch)
```json
{ "tool": "store", "args": { "action": "call", "name": "GuildMember", "method": "getMember", "args": ["466383682708996923", "279855366740258817"] } }
```

### store.snapshot — all getters at once (size-budgeted)
```json
{ "tool": "store", "args": { "action": "snapshot", "name": "SelectedChannel" } }
```
- **Only invokes ZERO-ARG getters.** `getterCount` is typically 2–3 even when `store.find` lists 20+ methods — anything needing args (e.g. `getMember(guildId,userId)`) is skipped. For those call `store.state`/`store.call` explicitly. Oversized values are string-truncated in place, so treat long fields as previews, not full data.

### store.links — data-flow position: syncsWith + subscriber counts + dispatch token
```json
{ "tool": "store", "args": { "action": "links", "name": "MessageStore" } }
```

`store.list` (no name) enumerates every store name.

---

## flux — dispatcher + store data-flow graph

Actions: `events`, `listeners`, `dispatch`, `graph`, `producers`, `chain`. All read-only except `dispatch`.

### flux.events — known action types (filterable)
```json
{ "tool": "flux", "args": { "action": "events", "filter": "MESSAGE", "limit": 100 } }
```

### flux.listeners — stores that handle an event
```json
{ "tool": "flux", "args": { "action": "listeners", "event": "MESSAGE_CREATE" } }
```

### flux.producers — modules that dispatch a given action type
```json
{ "tool": "flux", "args": { "action": "producers", "type": "TYPING_START" } }
```

### flux.graph — one store's dispatch band, handled actions, and dependsOn/dependents in the store DAG
```json
{ "tool": "flux", "args": { "action": "graph", "store": "ReadStateStore" } }
```

### flux.chain — full ordered handler chain for an action type (topological fan-out with bands)
```json
{ "tool": "flux", "args": { "action": "chain", "type": "CHANNEL_SELECT" } }
```

### flux.dispatch — send an action (DESTRUCTIVE — rejected by batch; use deliberately)
Fires a real action into the live dispatcher; every subscribing store reacts and UI updates. Confirm the payload shape first (via `flux.chain`/`flux.listeners`) before dispatching.
```json
{ "tool": "flux", "args": { "action": "dispatch", "type": "LAYER_PUSH", "payload": { "type": "USER_SETTINGS" } } }
```

---

## trace — capture action flows over time

Watch what actually dispatches while you interact. Actions: `start`, `get`, `stop`, `store`. Traces auto-expire.

- **Auto-expiry DISCARDS captures — get before the window closes.** Once `duration` elapses, `trace.get`/`trace.stop` return `Trace N not found` (and `trace.store` watches → `Watch N not found or expired`); the captured actions are gone, not retained. Always `trace.get` inside the window; `trace.stop` while still in-window returns the final results. Same rule for `intercept` (below).

### trace.start — begin capturing dispatched actions (optional regex `filter`)
```json
{ "tool": "trace", "args": { "action": "start", "filter": "MESSAGE|CHANNEL", "duration": 15000, "maxCaptures": 100 } }
```
Returns a trace `id`. Now perform the UI interaction you want to observe.

### trace.get — retrieve captured actions so far
```json
{ "tool": "trace", "args": { "action": "get", "id": 3 } }
```

### trace.stop — end and return results
```json
{ "tool": "trace", "args": { "action": "stop", "id": 3 } }
```

### trace.store — watch a store's state changes (instead of raw dispatches)
```json
{ "tool": "trace", "args": { "action": "store", "store": "SelectedChannelStore", "duration": 10000 } }
```

`duration` 1000–60000 ms. For static event/handler listing use `flux`/`store` instead — trace is for the temporal picture.

---

## intercept — capture live function calls

Wrap a specific export and record its args + return values as it's called. Actions: `set`, `get`, `stop`. Auto-expires.

`exportKey` accepts `"default"`, `"module"`, a named export, or a **dotted path** (e.g. `"A.sendMessage"` to reach a method on a named export object).

### intercept.set — start capturing calls to a module export
```json
{ "tool": "intercept", "args": { "action": "set", "moduleId": "228014", "exportKey": "Z.sendMessage", "duration": 60000, "maxCaptures": 50 } }
```
Returns an intercept `id`. Now trigger the code path (send a message, etc.).

### intercept.get — read captured args/returns
```json
{ "tool": "intercept", "args": { "action": "get", "id": 2 } }
```

### intercept.stop — restore the original function
```json
{ "tool": "intercept", "args": { "action": "stop", "id": 2 } }
```
`duration` 5000–120000 ms; it auto-expires and restores even if you forget to stop. Prefer `intercept` over `evaluateCode` monkey-patching — it cleans up after itself.

- **Like trace, expiry discards captures.** After `duration`, `intercept.get`/`intercept.stop` return `Trace N not found` and the recorded args/returns are lost. Read with `intercept.get` while the window is open; `intercept.stop` in-window returns the final captures.

---

## console — renderer error/warn ring buffer

Captures `error` + `warn` + uncaught errors + unhandled rejections since plugin start. Actions: `recent`, `stats`, `clear`.

**Check `console.recent` after every `reloadDiscord` and after any patch change** — it's how you confirm a patch didn't throw at module-eval or render time.

### console.recent — latest entries (filter by `level`, `sinceMs`, `limit`)
```json
{ "tool": "console", "args": { "action": "recent", "level": "error", "limit": 30 } }
```
```json
{ "tool": "console", "args": { "action": "recent", "sinceMs": 5000 } }
```

### console.stats — buffer counts
```json
{ "tool": "console", "args": { "action": "stats" } }
```

### console.clear — reset the buffer (clear before reload → recent after = a clean per-reload diff)
```json
{ "tool": "console", "args": { "action": "clear" } }
```

---

## discord — Discord context & utilities

Actions: `context`, `api`, `snowflake`, `endpoints`, `common`, `enum`, `constants`, `tokens`, `buildInfo`, `experiments`.

### discord.context — current user/channel/guild
```json
{ "tool": "discord", "args": { "action": "context" } }
```

### discord.buildInfo — release channel, build id, version hash, host + Equicord versions
```json
{ "tool": "discord", "args": { "action": "buildInfo" } }
```

### discord.experiments — registered experiment descriptors (filterable)
```json
{ "tool": "discord", "args": { "action": "experiments", "filter": "guild" } }
```

### discord.api — REST call (`method` one of get/post/patch/put/del)
```json
{ "tool": "discord", "args": { "action": "api", "method": "get", "endpoint": "/users/@me" } }
```

### discord.snowflake — decode an ID (timestamp, worker, process, increment)
```json
{ "tool": "discord", "args": { "action": "snowflake", "id": "852892297661906993" } }
```

### discord.enum — find the module defining an enum member
```json
{ "tool": "discord", "args": { "action": "enum", "memberName": "GUILD_TEXT" } }
```

Other actions: `endpoints` (API route table), `common` (Webpack.Common exports), `constants` (Discord constants), `tokens` (design tokens).

---

## plugin — plugin management

Actions: `list`, `enable`, `disable`, `toggle`, `settings`, `setSetting`. State changes are mutating (rejected by batch).

### plugin.list — all plugins + status (partial `name` filters; `showPatches`/`validate` optional)
```json
{ "tool": "plugin", "args": { "action": "list", "name": "keyword", "showPatches": true, "validate": true } }
```

### plugin.settings — read a plugin's settings
```json
{ "tool": "plugin", "args": { "action": "settings", "name": "KeywordNotify" } }
```

### plugin.setSetting — update one setting (MUTATING)
```json
{ "tool": "plugin", "args": { "action": "setSetting", "name": "KeywordNotify", "setting": "ignoreBots", "value": "true" } }
```

### plugin.toggle / enable / disable — state change (MUTATING; exact `name`)
```json
{ "tool": "plugin", "args": { "action": "toggle", "name": "BetterInvites" } }
```

---

## evaluateCode — the escape hatch

Execute arbitrary JS in the Discord renderer; returns the last expression. Use ONLY when no dedicated tool fits — dedicated tools are safer (auto-cleanup, size budgeting, structured output). MUTATING — rejected by batch.
```json
{ "tool": "evaluateCode", "args": { "code": "Vencord.Webpack.Common.UserStore.getCurrentUser().username" } }
```

---

## batch — up to 10 read-only calls in one round-trip

`calls: [{ tool, args }]`. Only read-only tool/action combos are accepted; mutating actions (`flux.dispatch`, `plugin.toggle`/`enable`/`disable`/`setSetting`, `store.call`, `module.loadLazy`, `evaluateCode`, `trace.*`/`intercept.*` mutations, `reloadDiscord`) are **rejected per-call**, not for the whole batch. Per-call errors are isolated — one failure doesn't sink the others.

**Batch-first is the rule:** every read-only tool/action is batchable and per-call errors are isolated, so a failing call never sinks its siblings — pack recon into one trip by default. Mutating actions are rejected **per-call** (the offending call errors, the read-only calls in the same batch still run) — never a whole-batch failure.

**Latency (plan your batches around it):** warm read-only calls are 30–300ms. But the **first `store`/`flux` call after startup pays a ~2s index-build cost** (warm thereafter) — fire one throwaway store/flux call early, or expect the first real one to be slow. **Patch registry scanners — `patch.broken` / `patch.conflicts` / `patch.analyze` — run 2–4.5s** (whole-registry walk); keep them OUT of latency-sensitive batches, run them standalone.

Use it to gather context in a single trip: e.g. store state + flux listeners + console check together.
```json
{
  "tool": "batch",
  "args": {
    "calls": [
      { "tool": "store", "args": { "action": "state", "name": "User", "method": "getCurrentUser" } },
      { "tool": "flux", "args": { "action": "listeners", "event": "MESSAGE_CREATE" } },
      { "tool": "discord", "args": { "action": "context" } },
      { "tool": "console", "args": { "action": "recent", "level": "error", "limit": 10 } }
    ]
  }
}
```

---

## Typical runtime loops

- **Pixel → source:** `react.source` on the element → `module.explain` on the returned ID → author find/patch.
- **What fires on click:** `console.clear` → `trace.start` (filter) → interact → `trace.stop`.
- **What a function receives:** `intercept.set` (dotted `exportKey`) → trigger → `intercept.get` → `intercept.stop`.
- **After every reload:** `reloadDiscord` → `console.recent` (level `error`) to confirm nothing threw.
- **Store shape before dispatch:** `store.snapshot` / `flux.chain` to learn payload shape, then `flux.dispatch` deliberately.
