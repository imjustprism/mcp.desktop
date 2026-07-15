/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType, PluginNative, ReporterTestable } from "@utils/types";
import { Toasts } from "@webpack/common";

import { getToolTimeout } from "./timeouts";
import { installConsoleCapture, uninstallConsoleCapture } from "./tools/console_tool";
import {
    cleanupAllIntercepts,
    cleanupAllModuleWatches,
    cleanupAllTraces,
    clearCSSIndexCache,
    errMsg,
    mcpLogger as logger,
    serializeResult,
    toStructuredContent,
    withTimeout,
} from "./tools/index";
import { cacheTtlOf, HANDLERS, isCacheable, TOOLS } from "./tools/registry";
import { initKeyMapPersistence } from "./tools/utils";
import { CacheEntry, InitializeParams, MCPRequest, MCPResponse, SessionStats, ToolCallParams, ToolCallResult } from "./types";

const Native = VencordNative.pluginHelpers.mcp as PluginNative<typeof import("./native")>;

const toolCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 300;
const SLOW_TOOL_THRESHOLD_MS = 5000;
const POLL_BACKOFF = { IDLE_FEW: 5, IDLE_MANY: 20, DELAY_FAST_MS: 2, DELAY_MED_MS: 5, DELAY_SLOW_MS: 10 } as const;

function getCacheKey(tool: string, args: Record<string, unknown>): string {
    return `${tool}:${JSON.stringify(args)}`;
}

function getCachedResult(tool: string, args: Record<string, unknown>): unknown {
    if (!isCacheable(tool, actionOf(args))) return null;
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
    if (!isCacheable(tool, actionOf(args))) return;
    if (isObject(result) && "error" in result) return;
    const key = getCacheKey(tool, args);
    if (toolCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = toolCache.keys().next().value;
        if (firstKey) toolCache.delete(firstKey);
    }
    toolCache.set(key, { result, expiresAt: Date.now() + cacheTtlOf(tool) });
}

const settings = definePluginSettings({
    logRequests: {
        type: OptionType.BOOLEAN,
        description: "Log incoming MCP requests to console",
        default: false,
    },
});

function objectResult(obj: unknown, isError?: boolean): ToolCallResult {
    return { content: [{ type: "text", text: serializeResult(obj) }], structuredContent: toStructuredContent(obj), isError };
}

function resultHasError(v: unknown): boolean {
    return isObject(v) && (v as { error?: unknown }).error === true;
}

const MUTATING_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
    module: new Set(["loadLazy"]),
    plugin: new Set(["enable", "disable", "toggle", "setSetting"]),
};

function isMutatingCall(name: string, action: string | undefined): boolean {
    if (name === "reloadDiscord") return true;
    const actions = MUTATING_ACTIONS[name];
    return !!action && !!actions && actions.has(action);
}

function toast(message: string, type: string): void {
    Toasts.show({ id: Toasts.genId(), message, type });
}

async function executeToolCall(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const cached = getCachedResult(name, args);
    if (cached !== null) {
        const result = { ...(cached as object), cached: true };
        return objectResult(result, resultHasError(result));
    }

    const handler = HANDLERS.get(name);
    if (!handler) return errorResult({ message: `Unknown tool: ${name}` });

    try {
        const result = await handler(args);
        if (result == null) {
            return objectResult({ warning: `${name} returned no result`, args });
        }
        setCachedResult(name, args, result);
        if (isMutatingCall(name, actionOf(args))) toolCache.clear();
        const text = serializeResult(result);
        if (!text || text === "null" || text === "undefined") {
            return objectResult({ warning: `${name} produced empty output`, args });
        }
        return objectResult(result, resultHasError(result));
    } catch (error) {
        const message = errMsg(error);
        return errorResult({ message, tool: name, args });
    }
}

const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const SERVER_INFO = { name: "discord-mcp", title: "Discord Client Introspection", version: "1.0.0" };
const INSTRUCTIONS =
    "A Discord MCP server exposing the desktop client's internals to an AI client: webpack modules, Flux stores and dispatcher, the React tree, and the intl hash system. " +
    "Call discord.orient first for a one-call session bootstrap (ready state, runtime, counts, build, console errors, plugin totals, and a suggested next move). " +
    "Then work the skill loop: resolve a landmark (resolve) or search text (search, intl.search) to the owning module, read and annotate its source (module), " +
    "generate build-stable anchors (module.suggest, module.genFinds), then validate with testPatch and patch before writing. Inspect the live React/Flux/store runtime as needed. " +
    "Results carry both a text block and structuredContent.";

const sessionStats: SessionStats = {
    initialized: false,
    clientInfo: null,
    connectedAt: 0,
    requests: 0,
    toolCalls: 0,
    errors: 0,
};

const rpcResult = (id: MCPResponse["id"], result: unknown): MCPResponse => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: MCPResponse["id"], code: number, message: string): MCPResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const errorResult = (fields: Record<string, unknown>): ToolCallResult => objectResult({ error: true, ...fields }, true);
const actionOf = (args?: Record<string, unknown>): string | undefined => args?.action as string | undefined;

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

            const negotiated = clientProtocol && SUPPORTED_PROTOCOLS.has(clientProtocol) ? clientProtocol : LATEST_PROTOCOL;

            return rpcResult(id, {
                protocolVersion: negotiated,
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS,
            });
        }

        case "notifications/initialized":
            sessionStats.initialized = true;
            logger.info(`Session ready, ${TOOLS.length} tools available`);
            return null;

        case "ping":
            return rpcResult(id, {});

        case "notifications/cancelled":
            return null;

        case "tools/list":
            return rpcResult(id, { tools: TOOLS });

        case "tools/call": {
            sessionStats.toolCalls++;
            const params = request.params as ToolCallParams | undefined;

            if (!params?.name) {
                sessionStats.errors++;
                logger.error("tools/call: missing tool name");
                return rpcError(id, -32602, "Missing tool name");
            }

            if (!HANDLERS.has(params.name)) {
                sessionStats.errors++;
                logger.error(`Unknown tool: ${params.name}`);
                return rpcError(id, -32602, `Unknown tool: ${params.name}`);
            }

            const start = performance.now();
            const action = actionOf(params.arguments);
            const toolLabel = action ? `${params.name}.${action}` : params.name;
            let toolResult: ToolCallResult;
            try {
                const timeout = getToolTimeout(params.name, action);
                toolResult = await withTimeout(executeToolCall(params.name, params.arguments ?? {}), timeout, params.name);
            } catch (e) {
                const errorMsg = errMsg(e);
                logger.error(`${toolLabel}: ${errorMsg}`);
                toolResult = errorResult({ message: errorMsg, tool: params.name, action: action ?? null });
            }

            const elapsed = performance.now() - start;

            if (toolResult.isError) {
                sessionStats.errors++;
                logger.error(`${toolLabel} failed (${elapsed.toFixed(0)}ms)`);
            } else if (elapsed > SLOW_TOOL_THRESHOLD_MS) {
                logger.warn(`${toolLabel} slow (${elapsed.toFixed(0)}ms)`);
            } else if (settings.store.logRequests) {
                logger.info(`${toolLabel} ${elapsed.toFixed(0)}ms`);
            }

            return rpcResult(id, toolResult);
        }

        case "resources/list":
            return rpcResult(id, { resources: [] });

        case "prompts/list":
            return rpcResult(id, { prompts: [] });

        default:
            if (request.method.startsWith("notifications/")) return null;
            sessionStats.errors++;
            logger.warn(`Unknown method: ${request.method}`);
            return rpcError(id, -32601, `Method not found: ${request.method}`);
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
    description: "Discord MCP server that exposes the client's webpack, Flux, React, and intl internals to an AI client",
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
            toast(msg, status.running ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
            logger.info(`Status: ${msg}`);
        },
        async "Restart Server"() {
            logger.info("Restarting server...");
            await Native.stopServer();
            const result = await Native.startServer();
            toast(result.ok ? "MCP restarted" : "Restart failed", result.ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
        },
        "Session Info"() {
            const uptime = sessionStats.connectedAt ? Math.floor((Date.now() - sessionStats.connectedAt) / 1000) : 0;
            const msg = sessionStats.initialized
                ? `${sessionStats.clientInfo} | reqs:${sessionStats.requests} tools:${sessionStats.toolCalls} errs:${sessionStats.errors} | ${uptime}s`
                : "No active session";
            toast(msg, sessionStats.initialized ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE);
            logger.info(`Session: ${msg}`);
        },
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
            const { id, request } = pending;
            handleMCPRequest(request)
                .catch(e => rpcError(request.id, -32603, errMsg(e)))
                .then(response => Native.sendResponse(id, response));
            this.scheduleImmediate();
        } else {
            this.idleCount++;
            const delay = this.idleCount < POLL_BACKOFF.IDLE_FEW ? POLL_BACKOFF.DELAY_FAST_MS : this.idleCount < POLL_BACKOFF.IDLE_MANY ? POLL_BACKOFF.DELAY_MED_MS : POLL_BACKOFF.DELAY_SLOW_MS;
            this.pollTimeout = setTimeout(() => this.poll(), delay);
        }
    },

    async start(this: PluginInstance) {
        logger.info(`Starting MCP server, ${TOOLS.length} tools available`);

        const result = await Native.startServer();
        if (!result.ok) {
            logger.error("Failed to start server");
            return;
        }
        logger.info(`http://127.0.0.1:${result.port}`);

        this.polling = true;
        this.idleCount = 0;
        this.poll();
        Native.notifyRendererReady();

        installConsoleCapture();
        initKeyMapPersistence({
            read: () => Native.readKeyMap(),
            write: json => { void Native.writeKeyMap(json); },
        }).then(restored => {
            if (restored) logger.info(`Restored ${restored} recovered intl keys from disk`);
        }).catch(() => {});
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
        clearCSSIndexCache();
        uninstallConsoleCapture();
        toolCache.clear();
        Native.stopServer();
    },
});
