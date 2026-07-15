import { PluginNative } from "@utils/types";

import { MCPTool } from "../types";
import { handleConsole } from "./console_tool";
import { TOOLS as TOOL_DEFS } from "./definitions";
import { handleDiscord } from "./discord_tool";
import { handleFlux } from "./flux_tool";
import { handleGraph } from "./graph_tool";
import { handleIntercept } from "./intercept_tool";
import { handleIntl } from "./intl_tool";
import { handleModule } from "./module_tool";
import { handlePatch } from "./patch_tool";
import { handlePlugin } from "./plugin_tool";
import { handleReact } from "./react_tool";
import { handleResolve } from "./resolve_tool";
import { handleSearch } from "./search_tool";
import { handleStore } from "./store_tool";
import { handleTestPatch } from "./test_patch_tool";
import { handleTrace } from "./trace_tool";
import { mcpLogger } from "./utils";

const Native = VencordNative.pluginHelpers.mcp as PluginNative<typeof import("../native")>;

type ToolHandler = (args: any) => Promise<unknown> | unknown;

interface ToolEntry {
    name: string;
    handler: ToolHandler;
    cacheTtlMs?: number;
    nonCacheableActions?: readonly string[];
    neverCache?: boolean;
    readOnly?: boolean;
}

const ENTRIES: ToolEntry[] = [
    { name: "module", handler: handleModule, cacheTtlMs: 30_000, nonCacheableActions: ["loadLazy", "watch", "watchGet", "watchStop", "diff", "annotate", "extract"] },
    { name: "store", handler: handleStore, cacheTtlMs: 120_000, nonCacheableActions: ["call", "state", "snapshot", "links"] },
    { name: "intl", handler: handleIntl, cacheTtlMs: 60_000, readOnly: true },
    { name: "flux", handler: handleFlux, cacheTtlMs: 60_000, nonCacheableActions: ["dispatch"] },
    { name: "patch", handler: handlePatch, readOnly: true },
    { name: "react", handler: handleReact, readOnly: true },
    { name: "discord", handler: handleDiscord, nonCacheableActions: ["api"] },
    { name: "plugin", handler: handlePlugin, cacheTtlMs: 30_000, nonCacheableActions: ["toggle", "enable", "disable", "setSetting"] },
    { name: "search", handler: handleSearch, cacheTtlMs: 30_000, readOnly: true },
    { name: "graph", handler: handleGraph, cacheTtlMs: 300_000, readOnly: true },
    { name: "resolve", handler: handleResolve, cacheTtlMs: 120_000, readOnly: true },
    { name: "testPatch", handler: handleTestPatch, readOnly: true },
    { name: "trace", handler: handleTrace, nonCacheableActions: ["start", "get", "stop", "store"] },
    { name: "intercept", handler: handleIntercept, nonCacheableActions: ["set", "get", "stop"] },
    { name: "console", handler: handleConsole, neverCache: true, readOnly: true },
    { name: "batch", handler: handleBatch, neverCache: true, readOnly: true },
    {
        name: "evaluateCode",
        neverCache: true,
        handler: (args: { code?: string }) => {
            if (!args.code) return { error: true, message: "code required" };
            return (0, eval)(args.code);
        },
    },
    {
        name: "reloadDiscord",
        neverCache: true,
        handler: () => {
            Native.notifyReloadTriggered();
            setTimeout(() => location.reload(), 100);
            return { reloading: true, message: "Discord is reloading. The next request will automatically wait for Discord to be ready." };
        },
    },
];

const BATCHABLE: Readonly<Record<string, ReadonlySet<string> | "all">> = {
    intl: "all",
    search: "all",
    graph: "all",
    resolve: "all",
    testPatch: "all",
    react: "all",
    patch: "all",
    console: new Set(["recent", "stats"]),
    module: new Set(["find", "extract", "exports", "context", "diff", "functionAt", "structure", "stats", "suggest", "genFinds", "annotate", "css", "explain"]),
    store: new Set(["find", "list", "state", "snapshot", "links"]),
    flux: new Set(["events", "listeners", "graph", "producers", "chain"]),
    discord: new Set(["context", "snowflake", "endpoints", "common", "enum", "constants", "tokens", "buildInfo", "experiments"]),
    plugin: new Set(["list", "settings"]),
};

const MAX_BATCH_CALLS = 10;

interface BatchCall {
    tool?: string;
    args?: Record<string, unknown>;
}

async function handleBatch(args: { calls?: BatchCall[] }): Promise<unknown> {
    const all = Array.isArray(args.calls) ? args.calls : [];
    const calls = all.slice(0, MAX_BATCH_CALLS);
    if (!calls.length) return { error: true, message: `calls required: [{tool, args}] (1-${MAX_BATCH_CALLS})` };
    const dropped = all.length - calls.length;

    const results: unknown[] = [];
    for (const call of calls) {
        const tool = call?.tool ?? "";
        const callArgs = call?.args ?? {};
        const action = typeof callArgs.action === "string" ? callArgs.action : undefined;
        const allowed = BATCHABLE[tool];
        if (!allowed || (allowed !== "all" && !allowed.has(action ?? ""))) {
            results.push({ tool, action: action ?? null, error: true, message: "not batchable — batch only accepts read-only tool/action combinations" });
            continue;
        }
        const handler = byName.get(tool)?.handler;
        if (!handler) {
            results.push({ tool, error: true, message: `Unknown tool: ${tool}` });
            continue;
        }
        try {
            results.push({ tool, action: action ?? null, result: await handler(callArgs) });
        } catch (e) {
            results.push({ tool, action: action ?? null, error: true, message: e instanceof Error ? e.message : String(e) });
        }
    }
    return {
        count: results.length,
        ...(dropped > 0 ? { truncated: true, dropped, note: `batch accepts max ${MAX_BATCH_CALLS} calls; ${dropped} dropped` } : {}),
        results,
    };
}

const byName = new Map(ENTRIES.map(e => [e.name, e]));

{
    const defNames = new Set(TOOL_DEFS.map(t => t.name));
    for (const name of byName.keys()) if (!defNames.has(name)) mcpLogger.error(`registry: tool "${name}" has a handler but no definition`);
    for (const name of defNames) if (!byName.has(name)) mcpLogger.error(`registry: tool "${name}" has a definition but no handler`);
}

export const HANDLERS: ReadonlyMap<string, ToolHandler> = new Map(ENTRIES.map(e => [e.name, e.handler]));

export const TOOLS: MCPTool[] = TOOL_DEFS.map(def => {
    const entry = byName.get(def.name);
    return entry?.readOnly ? { ...def, annotations: { readOnlyHint: true } } : def;
});

const DEFAULT_CACHE_TTL = 10_000;

export function cacheTtlOf(tool: string): number {
    return byName.get(tool)?.cacheTtlMs ?? DEFAULT_CACHE_TTL;
}

export function isCacheable(tool: string, action: string | undefined): boolean {
    const entry = byName.get(tool);
    if (!entry || entry.neverCache) return false;
    return !(action && entry.nonCacheableActions?.includes(action));
}
