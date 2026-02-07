/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MCPTool } from "../types";

export const TOOLS: MCPTool[] = [
    {
        name: "module",
        description: "Webpack modules. find: by props/code/displayName/className/exportName/pattern. extract: get source. exports: list with types. context: code around pattern. diff: patched vs original. deps: dependencies. size: bytes. ids: list IDs. stats: counts. loadLazy: load lazy chunks. watch/watchGet/watchStop: track new modules. suggest: find string candidates for patching. annotate: source with intl hashes replaced by key names. css: CSS module index/stats. components: discover UI components, props, variants.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["find", "extract", "exports", "context", "diff", "deps", "size", "ids", "stats", "loadLazy", "watch", "watchGet", "watchStop", "suggest", "annotate", "css", "components"],
                    description: "Action to perform"
                },
                id: {
                    type: "string",
                    description: "Module ID for extract/exports/context/diff/deps/size"
                },
                props: {
                    type: "array",
                    items: { type: "string" },
                    description: "Find by exported property names"
                },
                code: {
                    type: "array",
                    items: { type: "string" },
                    description: "Find by code snippets in exports"
                },
                displayName: {
                    type: "string",
                    description: "Find React component by displayName (partial unless exact=true)"
                },
                className: {
                    type: "string",
                    description: "Find CSS module by class name fragment, or reverse-lookup a rendered class (e.g. container_b2ca13)"
                },
                exportName: {
                    type: "string",
                    description: "Find by export name (checks Common first)"
                },
                exportValue: {
                    type: "string",
                    description: "Find by exact export value"
                },
                pattern: {
                    type: "string",
                    description: "Search pattern (string or /regex/flags)"
                },
                exact: {
                    type: "boolean",
                    description: "Exact displayName match",
                    default: false
                },
                patched: {
                    type: "boolean",
                    description: "Return patched source (false=original)",
                    default: true
                },
                all: {
                    type: "boolean",
                    description: "Return all matches, not just first",
                    default: false
                },
                limit: {
                    type: "number",
                    description: "Max results",
                    default: 20
                },
                maxLength: {
                    type: "number",
                    description: "Max source chars for extract",
                    default: 50000
                },
                chars: {
                    type: "number",
                    description: "Context chars for context action",
                    default: 100
                },
                duration: {
                    type: "number",
                    description: "Duration ms for watch (5000-120000)",
                    default: 30000
                },
                maxCaptures: {
                    type: "number",
                    description: "Max new modules to capture for watch",
                    default: 100
                },
                filter: {
                    type: "string",
                    description: "Regex filter for watch (matches module source)"
                },
                watchId: {
                    type: "number",
                    description: "Watch ID for watchGet/watchStop"
                }
            }
        }
    },
    {
        name: "store",
        description: "Flux stores. Auto-resolves 'User'→'UserStore'. list: all names. find: methods/getters/props. methods: prototype chain. state: get value. call: invoke method. subscriptions: handled events.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["find", "list", "state", "call", "subscriptions", "methods"],
                    description: "Action to perform"
                },
                name: {
                    type: "string",
                    description: "Store name (auto-resolves: 'User'→'UserStore')"
                },
                method: {
                    type: "string",
                    description: "Method/getter name for state/call"
                },
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: "Arguments for call action"
                },
                depth: {
                    type: "number",
                    description: "Prototype chain depth for methods",
                    default: 2
                },
                includeTypes: {
                    type: "boolean",
                    description: "Infer return types (calls getters)",
                    default: false
                }
            }
        }
    },
    {
        name: "intl",
        description: "Internationalization. hash: key→hash+message. reverse: hash→key+message. search: by message text. scan: extract hashes from module. targets: modules using key. bruteforce: check keymap for hash. test: try custom candidates/combinations against hash(es). Use #{intl::KEY} in patches.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["hash", "reverse", "search", "scan", "targets", "bruteforce", "test"],
                    description: "Action to perform"
                },
                key: {
                    type: "string",
                    description: "Intl key (e.g. MESSAGE_EDITED)"
                },
                hash: {
                    type: "string",
                    description: "6-char hash (e.g. cduTBL)"
                },
                hashes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Multiple hashes to test at once (for test action)"
                },
                query: {
                    type: "string",
                    description: "Search messages by text"
                },
                moduleId: {
                    type: "string",
                    description: "Module ID for scan"
                },
                limit: {
                    type: "number",
                    description: "Max results",
                    default: 20
                },
                candidates: {
                    type: "array",
                    items: { type: "string" },
                    description: "Exact keys to test (for test action)"
                },
                prefixes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Prefixes to combine (for test action)"
                },
                suffixes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Suffixes to combine (for test action)"
                },
                mids: {
                    type: "array",
                    items: { type: "string" },
                    description: "Middle parts to combine (for test action)"
                },
                pattern: {
                    type: "string",
                    description: "Pattern with placeholders like {PREFIX}_{ACTION}_{SUFFIX} (for test action)"
                },
                parts: {
                    type: "object",
                    description: "Values for pattern placeholders, e.g. {PREFIX: ['USER', 'GUILD'], ACTION: ['DELETE', 'CREATE']}"
                }
            }
        }
    },
    {
        name: "flux",
        description: "Flux dispatcher. events: list all. types: action types. listeners: stores handling event. dispatch: send action.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["events", "types", "dispatch", "listeners"],
                    description: "Action to perform"
                },
                event: {
                    type: "string",
                    description: "Event name for listeners"
                },
                type: {
                    type: "string",
                    description: "Action type for dispatch"
                },
                payload: {
                    type: "object",
                    description: "Payload for dispatch (merged with type)"
                },
                filter: {
                    type: "string",
                    description: "Filter events/types (case-insensitive)"
                }
            }
        }
    },
    {
        name: "patch",
        description: "Patch validation. unique: check find matches 1 module. analyze: scan patches for NO_MATCH/MULTIPLE_MATCH. plugin: get patches with health. lint: score pattern quality. Use testPatch for full test.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["unique", "analyze", "plugin", "lint"],
                    description: "Action to perform"
                },
                find: {
                    type: "string",
                    description: "Find string (supports #{intl::KEY})"
                },
                match: {
                    type: "string",
                    description: "Match pattern (/regex/flags, use \\i for minified)"
                },
                replace: {
                    type: "string",
                    description: "Replacement for lint preview"
                },
                str: {
                    type: "string",
                    description: "Alternative to find for unique check"
                },
                pluginName: {
                    type: "string",
                    description: "Plugin name for plugin action"
                },
                showNoMatch: {
                    type: "boolean",
                    description: "Include NO_MATCH in analyze",
                    default: true
                },
                showMultiMatch: {
                    type: "boolean",
                    description: "Include MULTIPLE_MATCH in analyze",
                    default: true
                },
                showValid: {
                    type: "boolean",
                    description: "Include valid patches in analyze",
                    default: false
                },
                limit: {
                    type: "number",
                    description: "Max results",
                    default: 20
                }
            }
        }
    },
    {
        name: "react",
        description: "React/DOM. query: find elements. fiber: component tree. props/state/hooks: component data. contexts: providers. find: by component name/props. styles: computed CSS. tree: DOM subtree. modify: set styles/classes. text: content. path: CSS selector. forceUpdate: re-render. owner: parents. root: fiber stats.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["query", "styles", "modify", "tree", "text", "path", "fiber", "props", "hooks", "contexts", "find", "forceUpdate", "state", "owner", "root"],
                    description: "Action to perform"
                },
                selector: {
                    type: "string",
                    description: "CSS selector (required for most actions)"
                },
                componentName: {
                    type: "string",
                    description: "Component name or prop key (partial match)"
                },
                properties: {
                    type: "array",
                    items: { type: "string" },
                    description: "CSS properties for styles"
                },
                styles: {
                    type: "object",
                    description: "CSS to set for modify"
                },
                addClass: {
                    type: "string",
                    description: "Classes to add for modify"
                },
                removeClass: {
                    type: "string",
                    description: "Classes to remove for modify"
                },
                setAttribute: {
                    type: "object",
                    description: "Attributes to set for modify"
                },
                includeText: {
                    type: "boolean",
                    description: "Include text in query results",
                    default: false
                },
                includeByProps: {
                    type: "boolean",
                    description: "Search by prop keys too",
                    default: true
                },
                limit: {
                    type: "number",
                    description: "Max results",
                    default: 20
                },
                depth: {
                    type: "number",
                    description: "Max traversal depth",
                    default: 10
                },
                direction: {
                    type: "string",
                    enum: ["up", "down"],
                    description: "Fiber traversal direction",
                    default: "up"
                },
                includeProps: {
                    type: "boolean",
                    description: "Include props in fiber output",
                    default: false
                },
                breadth: {
                    type: "number",
                    description: "Max children per node for tree action",
                    default: 10
                }
            }
        }
    },
    {
        name: "discord",
        description: "Discord context. context: current user/channel/guild. api: REST calls. snowflake: decode ID. endpoints: list API routes. common: Webpack.Common modules. enum: find by member. memory: heap stats. performance: load times. gateway: websocket stats. waitForIpc: await IPC ready. constants: Discord constant categories. experiments: A/B test flags. platform: OS/build info + GLOBAL_ENV. tokens: design system colors/spacing/shadows. icons: URL builder functions.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["context", "api", "snowflake", "endpoints", "common", "enum", "memory", "performance", "gateway", "waitForIpc", "constants", "experiments", "platform", "tokens", "icons"],
                    description: "Action to perform"
                },
                method: {
                    type: "string",
                    enum: ["get", "post", "patch", "put", "del"],
                    description: "HTTP method for api"
                },
                endpoint: {
                    type: "string",
                    description: "API endpoint (e.g. /users/@me)"
                },
                body: {
                    type: "object",
                    description: "Request body for api"
                },
                id: {
                    type: "string",
                    description: "Snowflake ID to decode"
                },
                filter: {
                    type: "string",
                    description: "Filter for endpoints/common"
                },
                memberName: {
                    type: "string",
                    description: "Enum member name for enum action"
                },
                timeout: {
                    type: "number",
                    description: "Timeout ms for waitForIpc",
                    default: 10000
                }
            }
        }
    },
    {
        name: "plugin",
        description: "Plugin management. list: all with status. enable/disable/toggle: hot-reload or restart. settings: get with types. setSetting: update value.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "enable", "disable", "toggle", "settings", "setSetting"],
                    description: "Action to perform"
                },
                name: {
                    type: "string",
                    description: "Plugin name (exact for state changes, partial for info)"
                },
                showPatches: {
                    type: "boolean",
                    description: "Include patches in output",
                    default: false
                },
                validate: {
                    type: "boolean",
                    description: "Validate patches (slower)",
                    default: false
                },
                setting: {
                    type: "string",
                    description: "Setting key for setSetting"
                },
                value: {
                    type: "string",
                    description: "New value (JSON for objects/arrays/booleans)"
                }
            }
        }
    },
    {
        name: "search",
        description: "Search webpack module sources. Returns IDs with context snippet. Supports /regex/flags.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Search pattern (string or /regex/flags)"
                },
                regex: {
                    type: "boolean",
                    description: "Force regex mode",
                    default: false
                },
                limit: {
                    type: "number",
                    description: "Max results",
                    default: 10
                }
            },
            required: ["pattern"]
        }
    },
    {
        name: "testPatch",
        description: "Test patch before writing. Checks find uniqueness, applies match regex, validates captures, previews replacement. Shows canonicalized regex, match context, nearby anchors. Returns VALID/FIND_NOT_UNIQUE/MATCH_FAILED.",
        inputSchema: {
            type: "object",
            properties: {
                find: {
                    type: "string",
                    description: "Find string (supports #{intl::KEY})"
                },
                match: {
                    type: "string",
                    description: "Match pattern (/regex/flags, use \\i for minified)"
                },
                replace: {
                    type: "string",
                    description: "Replacement to preview"
                }
            },
            required: ["find", "match"]
        }
    },
    {
        name: "evaluateCode",
        description: "Execute JS in Discord renderer. Access to Vencord, wreq, stores, FluxDispatcher. Returns last expression. Use when no dedicated tool exists.",
        inputSchema: {
            type: "object",
            properties: {
                code: {
                    type: "string",
                    description: "JavaScript code (last expression returned)"
                }
            },
            required: ["code"]
        }
    },
    {
        name: "trace",
        description: "Flux tracing. events: list all. handlers: stores for event. storeEvents: events for store. start: capture actions. get: retrieve. stop: end. store: watch state changes. Auto-expires.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["events", "handlers", "storeEvents", "start", "get", "stop", "store"],
                    description: "Action to perform"
                },
                filter: {
                    type: "string",
                    description: "Regex to filter events"
                },
                event: {
                    type: "string",
                    description: "Event name for handlers"
                },
                id: {
                    type: "number",
                    description: "Trace ID for get/stop"
                },
                store: {
                    type: "string",
                    description: "Store name (auto-resolves)"
                },
                duration: {
                    type: "number",
                    description: "Duration ms (1000-60000)",
                    default: 10000
                },
                maxCaptures: {
                    type: "number",
                    description: "Max captures (1-500)",
                    default: 100
                },
                limit: {
                    type: "number",
                    description: "Max results for events",
                    default: 50
                }
            }
        }
    },
    {
        name: "intercept",
        description: "Intercept function calls. set: start capturing. get: retrieve args/returns. stop: restore. Captures args, returns, timestamps. Auto-expires. exportKey supports dotted paths (e.g. 'A.sendMessage').",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["set", "get", "stop"],
                    description: "set=start, get=retrieve calls, stop=restore"
                },
                moduleId: {
                    type: "string",
                    description: "Module ID to intercept (for set)"
                },
                exportKey: {
                    type: "string",
                    description: "'default', 'module', or named export",
                    default: "default"
                },
                id: {
                    type: "number",
                    description: "Intercept ID for get/stop"
                },
                duration: {
                    type: "number",
                    description: "Duration ms (5000-120000)",
                    default: 30000
                },
                maxCaptures: {
                    type: "number",
                    description: "Max captures (1-200)",
                    default: 50
                }
            }
        }
    },
    {
        name: "reloadDiscord",
        description: "Reload Discord to apply patches, code changes.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
];
