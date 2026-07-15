# mcp.desktop

An MCP server that exposes the Discord desktop client's internals to an AI assistant. It runs as a Vencord or Equicord plugin inside the Discord renderer. It has direct access to the webpack module graph, the Flux stores and dispatcher, the React tree, and the intl hash system. An AI client connects over local HTTP. It can search modules, generate build-stable patch anchors, author, validate, and repair patches, resolve intl keys, and inspect the live runtime.

The main use case is writing and debugging Vencord and Equicord patches. Production Discord ships minified names, so the tools work from stable anchors instead. Those are intl keys, CSS class suffixes, store display names, and the module dependency graph.

> Full disclosure, this is certified Claude slop. An AI wrote most of it, a human mostly nodded along, and against all odds it works. You are holding freshly generated machine output. No refunds.

## Requirements

- Discord desktop with Vencord or Equicord installed
- A from-source Vencord or Equicord dev checkout. The build and inject commands below run from that repo root, not from this plugin folder
- Node and pnpm to build
- An MCP client that can reach a local HTTP endpoint

## Install

Clone into your Vencord or Equicord `userplugins` folder:

```bash
cd src/userplugins
git clone https://github.com/imjustprism/mcp.desktop
```

Build and inject:

```bash
pnpm build --dev
pnpm inject
```

Enable the mcp plugin in Discord settings, then restart Discord.

## Connect your AI client

The plugin starts an MCP server on `http://127.0.0.1:8486` whenever Discord is open and the plugin is enabled. The server speaks JSON-RPC 2.0 over HTTP POST and binds to localhost only.

Point your MCP client at that URL. Every request POSTs to the root path. There is no separate route. The server advertises itself as `equicord-mcp`. For a client that only speaks stdio, put an HTTP bridge in front of it, for example `mcp-remote`.

Smoke-test that the server is up:

```bash
curl -s -X POST http://127.0.0.1:8486 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If the client does not see the server, start Discord first so the server is listening, then open the client session. Confirm the "MCP on :8486" toast appears in Discord.

## Tools

| Tool | What it does |
| --- | --- |
| `module` | Find, read, and inspect webpack modules. Search by props, code, display name, CSS class, export name, exact export value, or pattern. Extract source, list exports, diff patched against original, and watch newly registered modules. Get code `context` around a pattern, the full `functionAt` a pattern, a `structure` outline without source, and `stats` counts. Load lazy chunks (`loadLazy`) and `suggest` patch anchors. Generate ranked build-stable find candidates (`genFinds`), get a one-call module dossier (`explain`), read intl-annotated source, and index CSS classes. |
| `search` | Search module sources by string or regex, with an AND mode that matches modules containing every string. |
| `resolve` | Resolve any Discord landmark to its owning modules. Accepts an intl hash, a CSS class or hex suffix, a store name, a SCREAMING_SNAKE key, or a literal string. |
| `graph` | Module dependency graph built from require call sites. Lists imports, importedBy, the shortest path between two modules, a local neighborhood, and real public export names. |
| `store` | Flux stores. List them, find methods and getters, read state, call methods, snapshot getters, and show sync links, subscriber counts, and the dispatch token. |
| `flux` | Flux dispatcher and store data-flow graph. List action types, list the stores that handle an event, dispatch an action, find modules that produce an action, trace the ordered store handler chain, and show a store's dispatch band, handled actions, and dependsOn/dependents in the store DAG (`graph`). |
| `trace` | Record dispatched Flux actions or a single store's state changes over a time window. Captures auto expire. |
| `intercept` | Wrap a function to capture its arguments and return values, then restore the original. Captures auto expire. |
| `react` | Inspect the React tree and DOM. Query elements, walk fibers up or down, read props, state, hooks, and contexts, find elements by name or props, read computed `styles`, dump a DOM `tree`, get a selector `path` for an element, and bridge an on-screen element to its source module. |
| `intl` | Discord intl system. Hash a key, reverse a hash, search by message text, scan a module for hashes, and list the modules that use a key. Recover key names for unmapped hashes from live messages. Recovered keys persist to disk and reload on startup. Reset the hash-to-key cache (`clearCache`). |
| `discord` | Discord context and utilities. Current user, channel, and guild, REST calls, snowflake decoding, API endpoints, common modules, enums, constants, design tokens, build info, and registered experiments. |
| `patch` | Validate patches. Check find uniqueness, scan every plugin for broken patches, score pattern quality, list finder specs, and report modules patched by more than one plugin. Show one plugin's patches and health (`plugin`), the patches targeting a module (`diff`), and unconsumed patches (`broken`). Suggest fresh durable finds and a repaired match for a broken patch (`suggestFix`), and verify that a plugin's patches actually applied (`verifyApplied`). |
| `testPatch` | Dry run a single patch before writing it. Checks find uniqueness, the match regex, capture groups, a replacement preview, and post replace syntax. |
| `plugin` | Manage plugins. List with status, enable, disable, toggle, and read or update settings. |
| `console` | Renderer console ring buffer: recent errors and warnings, uncaught errors, and unhandled rejections. Report buffer counts (`stats`) and clear the buffer. Check after a reload or a patch change. |
| `batch` | Run up to ten read-only tool calls in one round-trip, with per-call error isolation. Mutating actions are rejected per call. |
| `evaluateCode` | Run JavaScript in the Discord renderer and return the last expression. For cases with no dedicated tool. |
| `reloadDiscord` | Reload the Discord renderer. The next request waits for it to become ready. |

## How it works

The plugin has two halves. The main process runs the HTTP server, queues incoming requests, and applies a per-tool timeout. The renderer poll loop pulls each request, runs the tool against the live webpack and React runtime, and returns the result. All tool logic lives in the renderer because that is where the Discord internals are.

Find generation lives in `finds/`. A hand-rolled JS tokenizer feeds a run enumerator that drops minified names and require or import spans. A durability scorer ranks the survivors. A match repairer diagnoses and widens or strips broken patch matches under fixed step budgets, so it degrades to "unrepaired" instead of hanging. That core has its own unit tests.

Requests never leave the machine. The server binds to `127.0.0.1` and rejects any non-local origin.

## Skill package

`skills/discord-modding/` bundles agent-facing docs for driving these tools: a `SKILL.md` quickstart plus reference files for the patch-authoring workflow, find generation, patch repair, the intl system, runtime introspection, module discovery, power combos, and a tables reference. Point an MCP client's skill loader at that directory.

## Security

The server has no authentication. Any process on your machine can reach `127.0.0.1:8486` and drive every tool. Some tools are powerful. `discord` `api` makes authenticated REST calls as your account, including writes and deletes. `flux` `dispatch` and `store` `call` mutate live client state. `evaluateCode` runs arbitrary JavaScript in the renderer. Tools can also read live account data such as your current user and DMs. Run this only on a machine you trust.

## Troubleshooting

- No connection. Start Discord first so the server is listening, then open the client. Confirm the "MCP on :8486" toast in Discord.
- Port already in use. Something else holds 8486. The console logs `EADDRINUSE`. Close the other listener, or change the port in `native.ts`.
- Stale answers. Read results are cached briefly (see Notes). Wait out the window or reload to force a fresh read.

## Notes

- The server runs only while Discord is open. Reloading the renderer keeps the server alive. Changes to the main process require a full Discord restart.
- Every tool response carries both a text block and structured content, so a client can read either form.
- Successful read results are cached per tool for a short window, from 10 seconds up to 5 minutes for `graph`. A cache hit is tagged `cached: true`. Live-state calls can return data that old, so reload or wait out the window when you need the current value.
- A find marked `unique` is unique only among the webpack factories loaded this session. It can still collide with a module in an unfetched lazy chunk. Run `module loadLazy` and re-check for screens you have not opened.
- The plugin has one setting, `logRequests`, off by default. It logs each incoming call to the console.
- The intl reverse map ships in `map/key_map.json`. Keys that are not in that map and are not referenced by name in loaded code cannot be reversed and stay as raw 6-character hashes. `intl recover` reconstructs many of these from live messages by hashing candidate key names and proving the match. Recovered keys are cached to disk and reload on the next start.

## License

This plugin is built on Vencord and Equicord and follows their GPL-3.0 licensing.
