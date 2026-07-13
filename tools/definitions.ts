import { MCPTool } from "../types";

export const TOOLS: MCPTool[] = [
    {
        name: "module",
        description:
            "Webpack modules. find: by props/code/displayName/className/exportName/pattern. extract: source. exports: list. context: code around pattern. diff: patched vs original. functionAt: full function at pattern. structure: outline without source. stats: counts. loadLazy: load lazy chunks. watch/watchGet/watchStop: track newly-registered modules. suggest: find patch anchors. annotate: intl-resolved source. css: CSS class index/lookup. explain: one-call dossier (role, real exports, imports, importedBy count, patchedBy, intl/store/dispatch fingerprint).",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["find", "extract", "exports", "context", "diff", "functionAt", "structure", "stats", "loadLazy", "watch", "watchGet", "watchStop", "suggest", "annotate", "css", "explain"],
                },
                id: { type: "string", description: "Module ID" },
                props: { type: "array", items: { type: "string" }, description: "Find by export props" },
                code: { type: "array", items: { type: "string" }, description: "Find by code in exports" },
                displayName: { type: "string", description: "Find component (partial, exact=true for exact)" },
                className: { type: "string", description: "Find CSS module by class name or rendered class (e.g. container_b2ca13)" },
                exportName: { type: "string", description: "Find by export name" },
                exportValue: { type: "string", description: "Find by exact export value" },
                pattern: { type: "string", description: "String or /regex/flags" },
                exact: { type: "boolean", default: false },
                patched: { type: "boolean", description: "Patched source (false=original)", default: true },
                all: { type: "boolean", description: "All matches", default: false },
                limit: { type: "number", default: 20 },
                maxLength: { type: "number", description: "Max chars for extract", default: 50000 },
                chars: { type: "number", description: "Context chars", default: 100 },
                duration: { type: "number", description: "Watch duration ms (5000-120000)", default: 30000 },
                maxCaptures: { type: "number", default: 100 },
                filter: { type: "string", description: "Regex filter for watch" },
                watchId: { type: "number" },
            },
        },
    },
    {
        name: "store",
        description: "Flux stores. Auto-resolves 'User' to 'UserStore'. list: names. find: methods/getters/props (method filters the listing). state/call: get value/invoke. snapshot: all getters (size-budgeted). links: syncsWith + subscriber counts + dispatch token.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["find", "list", "state", "call", "snapshot", "links"] },
                name: { type: "string", description: "Store name (auto-resolves)" },
                method: { type: "string", description: "Method/getter for state/call. Also filters the find listing" },
                args: { type: "array", items: { type: "string" }, description: "Args for call" },
            },
        },
    },
    {
        name: "intl",
        description: "Intl system. hash: key to hash. reverse: hash to key. search: find hashes by message text. scan: hashes in a module. targets: modules using a key. clearCache: reset the hash to key cache. Use #{intl::KEY} in patches.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["hash", "reverse", "search", "scan", "targets", "clearCache"] },
                key: { type: "string", description: "Intl key (e.g. MESSAGE_EDITED)" },
                hash: { type: "string", description: "6-char hash" },
                query: { type: "string", description: "Search text" },
                moduleId: { type: "string", description: "Module ID for scan" },
                limit: { type: "number", default: 20 },
            },
        },
    },
    {
        name: "flux",
        description: "Flux dispatcher + store data-flow graph. events: list action types. listeners: stores handling an event. dispatch: send action. graph: a store's dispatch band, handled actions, and dependsOn/dependents in the store DAG. producers: modules that dispatch a given action type. chain: the full ordered store-handler chain for an action type (topological fan-out with bands).",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["events", "dispatch", "listeners", "graph", "producers", "chain"] },
                event: { type: "string", description: "Event name (for listeners)" },
                type: { type: "string", description: "Action type (for dispatch/producers)" },
                store: { type: "string", description: "Store name (for graph)" },
                payload: { type: "object", description: "Dispatch payload" },
                filter: { type: "string", description: "Case-insensitive filter" },
                limit: { type: "number", default: 100, description: "Max events/handlers/dependents returned" },
            },
        },
    },
    {
        name: "patch",
        description: "Patch validation. unique: find matches 1 module. analyze: scan all plugins for broken patches. plugin: one plugin's patches+health. lint: pattern quality score. finds: validate webpack finders. conflicts: modules patched by multiple plugins. diff: patches targeting a module. broken: unconsumed patches.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["unique", "analyze", "plugin", "lint", "finds", "conflicts", "diff", "broken"] },
                find: { type: "string", description: "Find string (supports #{intl::KEY})" },
                match: { type: "string", description: "/regex/flags (\\i for minified vars)" },
                replace: { type: "string", description: "Replacement" },
                str: { type: "string", description: "Alt find for unique" },
                id: { type: "string", description: "Module ID for diff" },
                pluginName: { type: "string" },
                showNoMatch: { type: "boolean", default: true },
                showMultiMatch: { type: "boolean", default: true },
                showValid: { type: "boolean", default: false },
                limit: { type: "number", default: 20 },
                finders: {
                    type: "array",
                    description: "Finder specs: {type, args, plugin?}",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["byProps", "byCode", "store", "componentByCode", "exportedComponent", "cssClasses", "byClassNames"] },
                            args: { type: "array", items: { type: "string" } },
                            plugin: { type: "string" },
                        },
                        required: ["type", "args"],
                    },
                },
            },
        },
    },
    {
        name: "react",
        description: "React/DOM inspection. query: find elements. fiber: component tree (up/down). props/state/hooks: component data. contexts: providers. find: by name/props. styles: computed CSS. tree: DOM subtree. path: selector. source: bridge an on-screen element to its webpack module(s), export name, hint, and patchedBy. This is the pixel-to-source link for patch authoring.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["query", "styles", "tree", "path", "fiber", "props", "hooks", "contexts", "find", "state", "source"] },
                selector: { type: "string", description: "CSS selector" },
                componentName: { type: "string", description: "Component/prop name (partial)" },
                properties: { type: "array", items: { type: "string" }, description: "CSS properties for styles" },
                includeText: { type: "boolean", default: false },
                includeByProps: { type: "boolean", default: true },
                limit: { type: "number", default: 20 },
                depth: { type: "number", default: 10 },
                direction: { type: "string", enum: ["up", "down"], default: "up" },
                includeProps: { type: "boolean", default: false },
                breadth: { type: "number", default: 10 },
            },
        },
    },
    {
        name: "discord",
        description: "Discord context/utils. context: current user/channel/guild. api: REST calls. snowflake: decode ID. endpoints: API routes. common: Webpack.Common exports. enum: find module by member. constants: Discord constants. tokens: design tokens.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["context", "api", "snowflake", "endpoints", "common", "enum", "constants", "tokens"] },
                method: { type: "string", enum: ["get", "post", "patch", "put", "del"] },
                endpoint: { type: "string", description: "API endpoint" },
                body: { type: "object" },
                id: { type: "string", description: "Snowflake ID" },
                filter: { type: "string", description: "Filter string" },
                memberName: { type: "string", description: "Enum member" },
            },
        },
    },
    {
        name: "plugin",
        description: "Plugin management. list: all+status. enable/disable/toggle: state change. settings: get. setSetting: update.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "enable", "disable", "toggle", "settings", "setSetting"] },
                name: { type: "string", description: "Plugin name (exact for state, partial for list)" },
                showPatches: { type: "boolean", default: false },
                validate: { type: "boolean", description: "Check patch health", default: false },
                setting: { type: "string", description: "Setting key" },
                value: { type: "string", description: "New value" },
            },
        },
    },
    {
        name: "search",
        description: "Search webpack module sources. Returns IDs+context+hint. Supports /regex/flags. patterns: AND search (modules containing ALL strings).",
        inputSchema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "String or /regex/flags" },
                patterns: { type: "array", items: { type: "string" }, description: "AND search (2-10 strings)" },
                regex: { type: "boolean", default: false },
                limit: { type: "number", default: 10 },
            },
        },
    },
    {
        name: "resolve",
        description: "Feature GPS: resolve any Discord landmark to its owning module(s). Auto-detects the landmark type: intl hash (6 base64 chars), CSS class or 6-hex suffix, StoreName (displayName), SCREAMING_SNAKE (intl key, action type, or enum member), or literal string. Returns modules plus role hints. The one call for what owns an observable string, since minified names are dead.",
        inputSchema: {
            type: "object",
            properties: {
                landmark: { type: "string", description: "intl hash, CSS class or suffix, StoreName, SCREAMING_SNAKE key/action/enum, or any literal" },
                limit: { type: "number", default: 20 },
            },
        },
    },
    {
        name: "graph",
        description: "Module dependency graph (from require call-sites in factory source). imports: modules this one requires. importedBy: modules requiring this one. path: dependency path from id to `to`. neighborhood: local subgraph (nodes+edges). exports: real public export names (RealName to local), works even for unloaded modules.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["imports", "importedBy", "path", "neighborhood", "exports"] },
                id: { type: "string", description: "Module ID" },
                to: { type: "string", description: "Target module ID (for path)" },
                depth: { type: "number", description: "Max hops for path (default 12)" },
                limit: { type: "number", default: 20 },
            },
        },
    },
    {
        name: "testPatch",
        description: "Test a patch before writing it. Validates find uniqueness, match regex, captures, replacement preview, and post-replace syntax. Shows nearby anchors. Returns PASS/FIND_NOT_UNIQUE/MATCH_FAILED.",
        inputSchema: {
            type: "object",
            properties: {
                find: { type: "string", description: "Find string (supports #{intl::KEY})" },
                match: { type: "string", description: "/regex/flags (\\i for minified)" },
                replace: { type: "string", description: "Replacement preview" },
            },
            required: ["find", "match"],
        },
    },
    {
        name: "evaluateCode",
        description: "Execute JS in Discord renderer. Returns last expression. Use when no dedicated tool exists.",
        inputSchema: {
            type: "object",
            properties: {
                code: { type: "string", description: "JavaScript code" },
            },
            required: ["code"],
        },
    },
    {
        name: "trace",
        description: "Flux action tracing. start: capture dispatched actions (optional regex filter). get: retrieve. stop: end+results. store: watch a store's state changes. Auto-expires. (For event/handler listing use the flux and store tools.)",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["start", "get", "stop", "store"] },
                filter: { type: "string", description: "Regex filter on action type (for start)" },
                id: { type: "number", description: "Trace ID" },
                store: { type: "string", description: "Store name (for store)" },
                duration: { type: "number", description: "ms (1000-60000)", default: 10000 },
                maxCaptures: { type: "number", default: 100 },
            },
        },
    },
    {
        name: "intercept",
        description: "Intercept function calls. set: start. get: retrieve args/returns. stop: restore original. exportKey supports dotted paths (e.g. 'A.sendMessage'). Auto-expires.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["set", "get", "stop"] },
                moduleId: { type: "string", description: "Module ID (for set)" },
                exportKey: { type: "string", description: "'default', 'module', named, or dotted path", default: "default" },
                id: { type: "number", description: "Intercept ID" },
                duration: { type: "number", description: "ms (5000-120000)", default: 30000 },
                maxCaptures: { type: "number", default: 50 },
            },
        },
    },
    {
        name: "reloadDiscord",
        description: "Reload Discord. Next request auto-waits for ready.",
        inputSchema: { type: "object", properties: {} },
    },
];
