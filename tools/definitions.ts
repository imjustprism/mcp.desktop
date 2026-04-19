/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MCPTool } from "../types";

export const TOOLS: MCPTool[] = [
    {
        name: "module",
        description:
            "Webpack modules. find: by props/code/displayName/className/exportName/pattern. extract: source. exports: list. context: code around pattern. diff: patched vs original. deps/whereUsed: dependencies. functionAt: full function at pattern. structure: outline without source. size: bytes. ids: list. patchedList: patched modules+plugins. findFactory: search raw factory. stats: counts. loadLazy: load lazy chunks. watch/watchGet/watchStop: track new modules. suggest: find patch anchors. annotate: intl-resolved source. css: class index. components: UI components+props.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["find", "extract", "exports", "context", "diff", "deps", "whereUsed", "functionAt", "structure", "size", "ids", "patchedList", "findFactory", "stats", "loadLazy", "watch", "watchGet", "watchStop", "suggest", "annotate", "css", "components"],
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
        description: "Flux stores. Auto-resolves 'User'→'UserStore'. list: names. find: methods/getters/props. methods: prototype chain. state/call: get value/invoke. subscriptions: handled events. snapshot: all getters.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["find", "list", "state", "call", "subscriptions", "methods", "snapshot"] },
                name: { type: "string", description: "Store name (auto-resolves)" },
                method: { type: "string", description: "Method/getter for state/call" },
                args: { type: "array", items: { type: "string" }, description: "Args for call" },
                depth: { type: "number", default: 2 },
                includeTypes: { type: "boolean", default: false },
            },
        },
    },
    {
        name: "intl",
        description: "Intl system. hash: key→hash. reverse: hash→key. search: by message text. scan: hashes in module. targets: modules using key. bruteforce: crack hash(es). test: try candidates against hash(es). unknown: uncracked hashes. neighbors: surrounding keys. clearCache: reset cache. Use #{intl::KEY} in patches.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["hash", "reverse", "search", "scan", "targets", "bruteforce", "test", "unknown", "neighbors", "clearCache"] },
                key: { type: "string", description: "Intl key (e.g. MESSAGE_EDITED)" },
                hash: { type: "string", description: "6-char hash" },
                hashes: { type: "array", items: { type: "string" }, description: "Multiple hashes for test" },
                query: { type: "string", description: "Search text" },
                moduleId: { type: "string", description: "Module ID for scan" },
                limit: { type: "number", default: 20 },
                candidates: { type: "array", items: { type: "string" }, description: "Keys to test" },
                prefixes: { type: "array", items: { type: "string" }, description: "Prefixes to combine" },
                suffixes: { type: "array", items: { type: "string" }, description: "Suffixes to combine" },
                mids: { type: "array", items: { type: "string" }, description: "Middle parts to combine" },
                pattern: { type: "string", description: "Template with {PLACEHOLDERS}" },
                parts: { type: "object", description: "Placeholder values: {PREFIX: ['USER','GUILD']}" },
            },
        },
    },
    {
        name: "flux",
        description: "Flux dispatcher. events/types: list. listeners: stores for event. dispatch: send action.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["events", "types", "dispatch", "listeners"] },
                event: { type: "string", description: "Event name" },
                type: { type: "string", description: "Action type for dispatch" },
                payload: { type: "object", description: "Dispatch payload" },
                filter: { type: "string", description: "Case-insensitive filter" },
                limit: { type: "number", default: 100, description: "Max events/handlers returned" },
            },
        },
    },
    {
        name: "patch",
        description: "Patch validation. unique: find matches 1 module. analyze: scan for broken patches. plugin: patches+health. lint: pattern quality. finds: validate webpack finders. benchmark: time patches. compare: A/B test. slowscan: rank by speed. conflicts: multi-plugin modules. diff: patch changes. broken: unconsumed patches.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["unique", "analyze", "plugin", "lint", "finds", "benchmark", "compare", "slowscan", "conflicts", "diff", "broken"] },
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
                iterations: { type: "number", default: 10000 },
                rounds: { type: "number", default: 3 },
                matchA: { type: "string" },
                matchB: { type: "string" },
                replaceA: { type: "string" },
                replaceB: { type: "string" },
            },
        },
    },
    {
        name: "react",
        description: "React/DOM inspection. query: find elements. fiber: component tree (up/down). props/state/hooks: component data. contexts: providers. find: by name/props. styles: computed CSS. tree: DOM subtree. modify: set styles/classes. text: content. path: selector. forceUpdate: re-render. owner: parent components. root: fiber stats.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["query", "styles", "modify", "tree", "text", "path", "fiber", "props", "hooks", "contexts", "find", "forceUpdate", "state", "owner", "root"] },
                selector: { type: "string", description: "CSS selector" },
                componentName: { type: "string", description: "Component/prop name (partial)" },
                properties: { type: "array", items: { type: "string" }, description: "CSS properties for styles" },
                styles: { type: "object", description: "CSS for modify" },
                addClass: { type: "string" },
                removeClass: { type: "string" },
                setAttribute: { type: "object" },
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
        description: "Discord context/utils. context: current user/channel/guild. api: REST calls. snowflake: decode ID. endpoints: API routes. common: Webpack.Common. enum: find by member. memory/performance: stats. gateway: websocket. waitForIpc: await ready. constants: Discord constants. experiments: A/B flags. platform: OS/build. tokens: design tokens. icons: URL builders. buildInfo: build number/hash.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["context", "api", "snowflake", "endpoints", "common", "enum", "memory", "performance", "gateway", "waitForIpc", "constants", "experiments", "platform", "tokens", "icons", "buildInfo"] },
                method: { type: "string", enum: ["get", "post", "patch", "put", "del"] },
                endpoint: { type: "string", description: "API endpoint" },
                body: { type: "object" },
                id: { type: "string", description: "Snowflake ID" },
                filter: { type: "string", description: "Filter string" },
                memberName: { type: "string", description: "Enum member" },
                timeout: { type: "number", default: 10000 },
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
        name: "testPatch",
        description: "Test patch before writing. Validates find uniqueness, match regex, captures, replacement preview. Shows anchors. Returns VALID/FIND_NOT_UNIQUE/MATCH_FAILED.",
        inputSchema: {
            type: "object",
            properties: {
                find: { type: "string", description: "Find string (supports #{intl::KEY})" },
                match: { type: "string", description: "/regex/flags (\\i for minified)" },
                replace: { type: "string", description: "Replacement preview" },
                benchmark: { type: "boolean", default: false },
                iterations: { type: "number", default: 10000 },
                rounds: { type: "number", default: 3 },
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
        description: "Flux tracing. events: list. handlers: stores for event. storeEvents: events for store. start: capture actions. get: retrieve. stop: end+results. store: watch state changes. Auto-expires.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["events", "handlers", "storeEvents", "start", "get", "stop", "store"] },
                filter: { type: "string", description: "Regex filter" },
                event: { type: "string" },
                id: { type: "number", description: "Trace ID" },
                store: { type: "string", description: "Store name" },
                duration: { type: "number", description: "ms (1000-60000)", default: 10000 },
                maxCaptures: { type: "number", default: 100 },
                limit: { type: "number", default: 50 },
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
