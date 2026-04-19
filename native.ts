/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";

import { DEFAULT_TIMEOUT_MS, getToolTimeout } from "./timeouts";
import { JSONValue, MCPRequest, MCPResponse, ServerStats, ServerStatus } from "./types";

const PORT = 8486;
const HOST = "127.0.0.1";
const MAX_BODY_SIZE = 65536;

const enum RPCError {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    Timeout = -32001,
    ServerBusy = -32002,
    RendererUnavailable = -32003,
}

function getRequestTimeout(request: MCPRequest): number {
    if (request.method !== "tools/call") return DEFAULT_TIMEOUT_MS;
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!params?.name) return DEFAULT_TIMEOUT_MS;
    return getToolTimeout(params.name, params.arguments?.action as string | undefined);
}

let rendererReady = true;
const readyWaiters: Array<() => void> = [];

export function notifyReloadTriggered(): void {
    rendererReady = false;
}

export function notifyRendererReady(): void {
    if (rendererReady) return;
    rendererReady = true;
    while (readyWaiters.length) readyWaiters.shift()!();
}

function waitForRenderer(timeoutMs = 30_000): Promise<boolean> {
    if (rendererReady) return Promise.resolve(true);
    return new Promise(resolve => {
        const resolver = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => {
            const idx = readyWaiters.indexOf(resolver);
            if (idx >= 0) readyWaiters.splice(idx, 1);
            resolve(false);
        }, timeoutMs);
        readyWaiters.push(resolver);
    });
}

let server: Server | null = null;
let requestId = 0;

interface QueuedRequest {
    id: number;
    request: MCPRequest;
    priority: number;
}

const requestQueue: QueuedRequest[] = [];
const pendingRequests = new Map<number, (response: MCPResponse | null) => void>();
const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

const stats: ServerStats = { startedAt: 0, requests: 0, success: 0, errors: 0, timeouts: 0 };

const PRIORITY: Readonly<Record<string, number>> = {
    initialize: 0,
    "tools/list": 1,
    "tools/call": 2,
};

function readBody(req: IncomingMessage): Promise<string> {
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);

    if (contentLength > 0 && contentLength < MAX_BODY_SIZE) {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.allocUnsafe(contentLength);
            let offset = 0;
            req.on("data", (chunk: Buffer) => {
                chunk.copy(buffer, offset);
                offset += chunk.length;
            });
            req.on("end", () => resolve(buffer.toString("utf8", 0, offset)));
            req.on("error", reject);
        });
    }

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(chunks.length === 1 ? chunks[0].toString() : Buffer.concat(chunks, size).toString()));
        req.on("error", reject);
    });
}

function writeJSON(res: ServerResponse, statusCode: number, body: string): void {
    const buf = Buffer.from(body);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": buf.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Connection: "keep-alive",
    });
    res.end(buf);
}

function makeError(id: number | string | null, code: RPCError, message: string, data?: JSONValue): MCPResponse {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data != null ? { data } : {}) } };
}

function sendError(res: ServerResponse, id: number | string | null, code: RPCError, message: string, data?: JSONValue): void {
    stats.errors++;
    writeJSON(res, 200, JSON.stringify(makeError(id, code, message, data)));
}

function clearPending(reason: string): void {
    pendingRequests.forEach((resolve, id) => resolve(makeError(id, RPCError.InternalError, reason)));
    pendingRequests.clear();
    pendingTimers.forEach(timer => clearTimeout(timer));
    pendingTimers.clear();
    requestQueue.length = 0;
}

export function getNextRequest(): { id: number; request: MCPRequest } | null {
    if (!requestQueue.length) return null;

    let bestIdx = 0;
    for (let i = 1; i < requestQueue.length; i++) {
        if (requestQueue[i].priority < requestQueue[bestIdx].priority) bestIdx = i;
    }

    const [item] = requestQueue.splice(bestIdx, 1);
    return { id: item.id, request: item.request };
}

export function sendResponse(_event: Electron.IpcMainInvokeEvent, id: number, response: MCPResponse | null): void {
    const resolve = pendingRequests.get(id);
    if (!resolve) return;
    pendingRequests.delete(id);
    const timer = pendingTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(id);
    }
    resolve(response);
}

export function startServer(): { ok: boolean; port: number } {
    clearPending("Server restarting");

    if (server) return { ok: true, port: PORT };

    server = createServer(async (req, res) => {
        stats.requests++;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400",
            });
            res.end();
            return;
        }

        if (req.method !== "POST") {
            sendError(res, null, RPCError.InvalidRequest, `Expected POST, got ${req.method}`);
            return;
        }

        let body: string;
        try {
            body = await readBody(req);
        } catch (e) {
            sendError(res, null, RPCError.ParseError, `Failed to read request body: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        let request: MCPRequest;
        try {
            request = JSON.parse(body) as MCPRequest;
        } catch {
            sendError(res, null, RPCError.ParseError, "Request body is not valid JSON");
            return;
        }

        if (request.jsonrpc !== "2.0") {
            sendError(res, request.id ?? null, RPCError.InvalidRequest, `Expected jsonrpc "2.0", got "${request.jsonrpc}"`);
            return;
        }

        if (!rendererReady) {
            const ok = await waitForRenderer();
            if (!ok) {
                sendError(res, request.id ?? null, RPCError.RendererUnavailable, "Renderer did not become ready within 30s");
                return;
            }
        }

        const id = (requestId = (requestId + 1) & 0x7fffffff);
        const priority = PRIORITY[request.method] ?? 10;
        const timeout = getRequestTimeout(request);

        const response = await new Promise<MCPResponse | null>(resolve => {
            pendingRequests.set(id, resolve);

            pendingTimers.set(
                id,
                setTimeout(() => {
                    if (!pendingRequests.has(id)) return;
                    pendingRequests.delete(id);
                    pendingTimers.delete(id);
                    stats.timeouts++;

                    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
                    const tool = params?.name ?? request.method;
                    const action = params?.arguments?.action as string | undefined;
                    const detail = action ? `${tool}:${action}` : tool;

                    resolve(
                        makeError(request.id, RPCError.Timeout, `${detail} did not respond within ${Math.round(timeout / 1000)}s. The renderer may be blocked or the operation is too expensive.`, {
                            tool,
                            action: action ?? null,
                            timeoutMs: timeout,
                        }),
                    );
                }, timeout),
            );

            requestQueue.push({ id, request, priority });
        });

        if (response === null) {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
        } else {
            if ("error" in response) stats.errors++;
            else stats.success++;
            writeJSON(res, 200, JSON.stringify(response));
        }
    });

    server.keepAliveTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.maxHeadersCount = 20;
    server.timeout = 0;

    server.on("error", (err: NodeJS.ErrnoException) => {
        console.error("[mcp]", err.code === "EADDRINUSE" ? `Port ${PORT} already in use` : err.message);
    });

    server.on("listening", () => {
        stats.startedAt = Date.now();
    });

    server.listen(PORT, HOST);
    return { ok: true, port: PORT };
}

export function stopServer(): { ok: boolean } {
    clearPending("Server stopped");
    server?.close();
    server = null;
    return { ok: true };
}

export function getServerStatus(): ServerStatus {
    const uptime = stats.startedAt ? Date.now() - stats.startedAt : 0;
    return {
        running: server !== null,
        port: PORT,
        stats: {
            ...stats,
            pendingRequests: pendingRequests.size,
            queuedRequests: requestQueue.length,
            uptimeFormatted: uptime ? `${Math.floor(uptime / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s` : null,
        },
    };
}
