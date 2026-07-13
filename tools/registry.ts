import { PluginNative } from "@utils/types";

import { MCPTool } from "../types";
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
