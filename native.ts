/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";

import { MCPRequest, MCPResponse, ServerStats, ServerStatus } from "./types";

const PORT = 8486;
const HOST = "127.0.0.1";
const MAX_BODY_SIZE = 65536;
const REQUEST_TIMEOUT = 30000;

function getRequestTimeout(request: MCPRequest): number {
    if (request.method === "tools/call" && request.params?.name === "intl") {
        const args = request.params.arguments as Record<string, unknown> | undefined;
        if (args?.action === "bruteforce") return 600000;
    }
    return REQUEST_TIMEOUT;
}

let reloadWaitUntil = 0;
const RELOAD_WAIT_MS = 3000;

export function notifyReloadTriggered(): void {
    reloadWaitUntil = Date.now() + RELOAD_WAIT_MS + 1000;
}

export function notifyRendererReady(): void {
    if (reloadWaitUntil > 0) {
        reloadWaitUntil = Date.now() + RELOAD_WAIT_MS;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
const timeouts = new Map<number, ReturnType<typeof setTimeout>>();

const stats: ServerStats = { startedAt: 0, requests: 0, success: 0, errors: 0, timeouts: 0 };

const PRIORITY_METHODS: Readonly<Record<string, number>> = {
    "tools/call": 1,
    "initialize": 2,
    "tools/list": 3,
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
                reject(new Error("Body too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            resolve(chunks.length === 1 ? chunks[0].toString() : Buffer.concat(chunks, size).toString());
        });
        req.on("error", reject);
    });
}

function writeResponse(res: ServerResponse, statusCode: number, json: string): void {
    const body = Buffer.from(json);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Connection": "keep-alive",
    });
    res.end(body);
}

function sendError(res: ServerResponse, id: number | string | null, code: number, message: string): void {
    stats.errors++;
    const idStr = id === null ? "null" : typeof id === "string" ? `"${id}"` : id;
    writeResponse(res, 200, `{"jsonrpc":"2.0","id":${idStr},"error":{"code":${code},"message":"${message}"}}`);
}

export function getNextRequest(): { id: number; request: MCPRequest } | null {
    if (requestQueue.length === 0) return null;

    if (requestQueue.length > 1) {
        let minIdx = 0;
        let minPriority = requestQueue[0].priority;
        for (let i = 1; i < requestQueue.length; i++) {
            if (requestQueue[i].priority < minPriority) {
                minPriority = requestQueue[i].priority;
                minIdx = i;
            }
        }
        if (minIdx !== 0) {
            const item = requestQueue[minIdx];
            requestQueue.splice(minIdx, 1);
            return { id: item.id, request: item.request };
        }
    }

    const item = requestQueue.shift()!;
    return { id: item.id, request: item.request };
}

export function sendResponse(_event: Electron.IpcMainInvokeEvent, id: number, response: MCPResponse | null): void {
    const resolve = pendingRequests.get(id);
    if (resolve) {
        pendingRequests.delete(id);
        const timeout = timeouts.get(id);
        if (timeout) {
            clearTimeout(timeout);
            timeouts.delete(id);
        }
        resolve(response);
    }
}

function clearPendingRequests(errorMessage: string): void {
    for (const resolve of pendingRequests.values()) {
        resolve({ jsonrpc: "2.0", id: null, error: { code: -32603, message: errorMessage } });
    }
    pendingRequests.clear();
    for (const t of timeouts.values()) clearTimeout(t);
    timeouts.clear();
    requestQueue.length = 0;
}

export function startServer(): { ok: boolean; port: number } {
    clearPendingRequests("Session reset");

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
            sendError(res, null, -32600, "Only POST method allowed");
            return;
        }

        let body: string;
        try {
            body = await readBody(req);
        } catch {
            sendError(res, null, -32700, "Failed to read body");
            return;
        }

        let request: MCPRequest;
        try {
            request = JSON.parse(body) as MCPRequest;
        } catch {
            sendError(res, null, -32700, "Invalid JSON");
            return;
        }

        if (request.jsonrpc !== "2.0") {
            sendError(res, request.id ?? null, -32600, "Must use JSON-RPC 2.0");
            return;
        }

        if (reloadWaitUntil > 0) {
            const waitTime = reloadWaitUntil - Date.now();
            if (waitTime > 0) {
                await sleep(waitTime);
            }
            reloadWaitUntil = 0;
        }

        const id = requestId = (requestId + 1) & 0x7FFFFFFF;
        const priority = PRIORITY_METHODS[request.method] ?? 10;

        const response = await new Promise<MCPResponse | null>(resolve => {
            pendingRequests.set(id, resolve);
            timeouts.set(id, setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    timeouts.delete(id);
                    stats.timeouts++;
                    resolve({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Timeout" } });
                }
            }, getRequestTimeout(request)));
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
            writeResponse(res, 200, JSON.stringify(response));
        }
    });

    server.keepAliveTimeout = 10000;
    server.headersTimeout = 5000;
    server.maxHeadersCount = 20;
    server.timeout = 35000;

    server.on("error", (err: NodeJS.ErrnoException) => {
        console.error("[mcp]", err.code === "EADDRINUSE" ? `Port ${PORT} in use` : err.message);
    });

    server.on("listening", () => { stats.startedAt = Date.now(); });

    server.listen(PORT, HOST);
    return { ok: true, port: PORT };
}

export function stopServer(): { ok: boolean } {
    clearPendingRequests("Server stopped");
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
            uptimeFormatted: uptime ? `${Math.floor(uptime / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s` : null
        }
    };
}
