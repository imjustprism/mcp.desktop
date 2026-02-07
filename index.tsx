/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, ReporterTestable } from "@utils/types";
import { Toasts } from "@webpack/common";

import {
    cleanupAllIntercepts,
    cleanupAllModuleWatches,
    cleanupAllTraces,
    clearComponentIndexCache,
    clearCSSIndexCache,
    getAdaptiveTimeout,
    handleDiscordTool,
    handleFluxTool,
    handleInterceptTool,
    handleIntlTool,
    handleModuleTool,
    handlePatchTool,
    handlePluginTool,
    handleReactTool,
    handleSearchTool,
    handleStoreTool,
    handleTestPatchTool,
    handleTraceTool,
    serializeResult,
    TOOLS,
    withTimeout,
} from "./tools/index";
import { CacheEntry, InitializeParams, IPCMCPRequest, MCPRequest, MCPResponse, SessionStats, ToolCallParams, ToolCallResult } from "./types";

const Native = VencordNative.pluginHelpers.mcp as PluginNative<typeof import("./native")>;
const logger = new Logger("mcp", "#d97756");

const toolCache = new Map<string, CacheEntry>();
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
const TOOL_CACHE_TTLS: Readonly<Record<string, number>> = {
    store: 120000,
    module: 30000,
    search: 30000,
    intl: 60000,
    flux: 60000,
    plugin: 30000,
};
const DEFAULT_CACHE_TTL = 10000;
const MAX_CACHE_ENTRIES = 300;

function getCacheKey(tool: string, args: Record<string, unknown>): string {
    return `${tool}:${JSON.stringify(args)}`;
}

const NON_CACHEABLE_TOOLS = new Set(["reloadDiscord", "evaluateCode"]);
const NON_CACHEABLE_ACTIONS: Readonly<Record<string, Set<string>>> = {
    dom: new Set(["modify"]),
    flux: new Set(["dispatch"]),
    discord: new Set(["api"]),
    store: new Set(["call", "state"]),
    plugin: new Set(["toggle", "enable", "disable", "setSetting"]),
    module: new Set(["loadLazy", "watch", "watchGet", "watchStop", "diff", "annotate", "extract"]),
    trace: new Set(["start", "get", "stop", "store"]),
    intercept: new Set(["set", "get", "stop"]),
};

function isCacheable(tool: string, args: Record<string, unknown>): boolean {
    if (NON_CACHEABLE_TOOLS.has(tool)) return false;
    const actions = NON_CACHEABLE_ACTIONS[tool];
    return !actions?.has(args.action as string);
}

function getCachedResult(tool: string, args: Record<string, unknown>): unknown | null {
    if (!isCacheable(tool, args)) return null;
    const key = getCacheKey(tool, args);
    const entry = toolCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        toolCache.delete(key);
        return null;
    }
    toolCache.delete(key);
    toolCache.set(key, entry);
    return entry.result;
}

function setCachedResult(tool: string, args: Record<string, unknown>, result: unknown): void {
    if (!isCacheable(tool, args)) return;
    if (result && typeof result === "object" && "error" in result) return;
    const key = getCacheKey(tool, args);
    const ttl = TOOL_CACHE_TTLS[tool] ?? DEFAULT_CACHE_TTL;
    if (toolCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = toolCache.keys().next().value;
        if (firstKey) toolCache.delete(firstKey);
    }
    toolCache.set(key, { result, expiresAt: Date.now() + ttl });
}

const settings = definePluginSettings({
    logRequests: {
        type: OptionType.BOOLEAN,
        description: "Log incoming MCP requests to console",
        default: false
    }
});

type ToolHandler = (args: any) => Promise<unknown> | unknown;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
    module: handleModuleTool,
    store: handleStoreTool,
    intl: handleIntlTool,
    flux: handleFluxTool,
    patch: handlePatchTool,
    react: handleReactTool,
    discord: handleDiscordTool,
    plugin: handlePluginTool,
    search: handleSearchTool,
    testPatch: handleTestPatchTool,
    trace: handleTraceTool,
    intercept: handleInterceptTool,
    evaluateCode: (args: { code?: string }) => (0, eval)(args.code as string),
    reloadDiscord: () => {
        Native.notifyReloadTriggered();
        setTimeout(() => location.reload(), 100);
        return { reloading: true, message: "Discord is reloading. The next request will automatically wait for Discord to be ready." };
    },
};

async function executeToolCall(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const cached = getCachedResult(name, args);
    if (cached !== null) {
        return { content: [{ type: "text", text: serializeResult({ ...cached as object, cached: true }) }] };
    }

    const handler = TOOL_HANDLERS[name];
    if (!handler) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };

    try {
        const result = await handler(args);
        setCachedResult(name, args, result);
        return { content: [{ type: "text", text: serializeResult(result) }] };
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "equicord-mcp", version: "1.0.0" };

const sessionStats: SessionStats = {
    initialized: false,
    clientInfo: null,
    connectedAt: 0,
    requests: 0,
    toolCalls: 0,
    errors: 0
};

async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse | null> {
    const { id } = request;
    sessionStats.requests++;

    switch (request.method) {
        case "initialize": {
            const params = request.params as InitializeParams | undefined;
            const clientName = params?.clientInfo?.name ?? "unknown";
            const clientVersion = params?.clientInfo?.version ?? "?";
            const clientProtocol = params?.protocolVersion;

            sessionStats.clientInfo = `${clientName} v${clientVersion}`;
            sessionStats.connectedAt = Date.now();

            logger.info(`Client: ${sessionStats.clientInfo}, protocol: ${clientProtocol ?? "?"}`);

            if (clientProtocol && clientProtocol !== PROTOCOL_VERSION) {
                logger.warn(`Protocol mismatch: client=${clientProtocol}, server=${PROTOCOL_VERSION}`);
            }

            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO
                }
            };
        }

        case "notifications/initialized":
            sessionStats.initialized = true;
            logger.info(`Session ready, ${TOOLS.length} tools available`);
            return null;

        case "ping":
            return { jsonrpc: "2.0", id, result: {} };

        case "notifications/cancelled":
            return null;

        case "tools/list":
            return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

        case "tools/call": {
            sessionStats.toolCalls++;
            const params = request.params as ToolCallParams | undefined;

            if (!params?.name) {
                sessionStats.errors++;
                logger.error("tools/call: missing tool name");
                return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
            }

            if (!TOOL_NAMES.has(params.name)) {
                sessionStats.errors++;
                logger.error(`Unknown tool: ${params.name}`);
                return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
            }

            const start = performance.now();
            let toolResult: ToolCallResult;
            try {
                const timeout = getAdaptiveTimeout(params.name, params.arguments);
                const isBruteforce = params.name === "intl" && params.arguments?.action === "bruteforce";
                toolResult = isBruteforce
                    ? await executeToolCall(params.name, params.arguments ?? {})
                    : await withTimeout(executeToolCall(params.name, params.arguments ?? {}), timeout, params.name);
            } catch (e) {
                sessionStats.errors++;
                const errorMsg = e instanceof Error ? e.message : String(e);
                logger.error(`${params.name}: ${errorMsg}`);
                toolResult = { content: [{ type: "text", text: `Error: ${errorMsg}` }], isError: true };
            }

            const elapsed = performance.now() - start;

            if (toolResult.isError) {
                sessionStats.errors++;
                logger.error(`${params.name} ${elapsed.toFixed(2)}ms`);
            } else if (elapsed > 5000) {
                logger.warn(`${params.name} ${elapsed.toFixed(2)}ms`);
            } else if (settings.store.logRequests) {
                logger.info(`${params.name} ${elapsed.toFixed(2)}ms`);
            }

            return { jsonrpc: "2.0", id, result: toolResult };
        }

        case "resources/list":
            return { jsonrpc: "2.0", id, result: { resources: [] } };

        case "prompts/list":
            return { jsonrpc: "2.0", id, result: { prompts: [] } };

        default:
            if (request.method.startsWith("notifications/")) return null;
            sessionStats.errors++;
            logger.warn(`Unknown method: ${request.method}`);
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
}

interface PluginInstance {
    polling: boolean;
    pollTimeout: ReturnType<typeof setTimeout> | null;
    channel: MessageChannel | null;
    idleCount: number;
    scheduleImmediate(): void;
    poll(): Promise<void>;
    start(): Promise<void>;
    stop(): void;
}

export default definePlugin({
    name: "mcp",
    description: "Exposes webpack internals via MCP",
    authors: [Devs.prism],
    reporterTestable: ReporterTestable.None,
    settings,
    required: true,

    toolboxActions: {
        async "MCP Status"() {
            const status = await Native.getServerStatus();
            const s = status.stats;
            let msg = status.running ? `MCP on :${status.port}` : "MCP stopped";
            if (s && status.running) {
                msg += ` | reqs:${s.requests} ok:${s.success} err:${s.errors} timeouts:${s.timeouts}`;
                if (s.uptimeFormatted) msg += ` | up:${s.uptimeFormatted}`;
            }
            Toasts.show({ id: Toasts.genId(), message: msg, type: status.running ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE });
            logger.info(`Status: ${msg}`);
        },
        async "Restart Server"() {
            logger.info("Restarting server...");
            await Native.stopServer();
            const result = await Native.startServer();
            Toasts.show({ id: Toasts.genId(), message: result.ok ? "MCP restarted" : "Restart failed", type: result.ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE });
        },
        "Session Info"() {
            const uptime = sessionStats.connectedAt ? Math.floor((Date.now() - sessionStats.connectedAt) / 1000) : 0;
            const msg = sessionStats.initialized
                ? `${sessionStats.clientInfo} | reqs:${sessionStats.requests} tools:${sessionStats.toolCalls} errs:${sessionStats.errors} | ${uptime}s`
                : "No active session";
            Toasts.show({ id: Toasts.genId(), message: msg, type: sessionStats.initialized ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE });
            logger.info(`Session: ${msg}`);
        }
    },

    polling: false,
    pollTimeout: null as ReturnType<typeof setTimeout> | null,
    channel: null as MessageChannel | null,
    idleCount: 0,

    scheduleImmediate(this: PluginInstance) {
        if (!this.polling) return;
        if (!this.channel) {
            this.channel = new MessageChannel();
            this.channel.port1.onmessage = () => this.poll();
        }
        this.channel.port2.postMessage(null);
    },

    async poll(this: PluginInstance) {
        if (!this.polling) return;

        const pending = await Native.getNextRequest();
        if (pending) {
            this.idleCount = 0;
            const { id, request } = pending as IPCMCPRequest;
            handleMCPRequest(request)
                .catch(e => ({ jsonrpc: "2.0" as const, id: request.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }))
                .then(response => Native.sendResponse(id, response));
            this.scheduleImmediate();
        } else {
            this.idleCount++;
            const delay = this.idleCount < 5 ? 2 : this.idleCount < 20 ? 5 : 10;
            this.pollTimeout = setTimeout(() => this.poll(), delay);
        }
    },

    async start(this: PluginInstance) {
        logger.info(`Starting MCP server, ${TOOLS.length} tools available`);

        Native.notifyRendererReady();

        const result = await Native.startServer();
        if (result.ok) {
            logger.info(`http://127.0.0.1:${result.port}`);
        } else {
            logger.error("Failed to start server");
            return;
        }

        this.polling = true;
        this.idleCount = 0;
        this.poll();
    },

    stop(this: PluginInstance) {
        logger.info(`Stopping: reqs=${sessionStats.requests} tools=${sessionStats.toolCalls} errs=${sessionStats.errors}`);
        this.polling = false;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        if (this.channel) {
            this.channel.port1.close();
            this.channel.port2.close();
            this.channel = null;
        }
        cleanupAllTraces();
        cleanupAllIntercepts();
        cleanupAllModuleWatches();
        clearComponentIndexCache();
        clearCSSIndexCache();
        toolCache.clear();
        Native.stopServer();
    }
});
