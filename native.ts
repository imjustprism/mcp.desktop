import { app, IpcMainInvokeEvent } from "electron";
import { promises as fs } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { join } from "path";

import { DEFAULT_TIMEOUT_MS, getToolTimeout } from "./timeouts";
import { IPCMCPRequest, JSONValue, MCPRequest, MCPResponse, ServerStats, ServerStatus, ToolCallParams } from "./types";

const PORT = 8486;
const HOST = "127.0.0.1";
const MAX_BODY_SIZE = 65536;
const REQUEST_ID_MASK = 0x7fffffff;
const DEFAULT_REQUEST_PRIORITY = 10;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;
const SERVER_KEEPALIVE_TIMEOUT_MS = 10_000;
const SERVER_HEADERS_TIMEOUT_MS = 5_000;
const SERVER_MAX_HEADERS = 20;

const enum RPCError {
    ParseError = -32700,
    InvalidRequest = -32600,
    InternalError = -32603,
    Timeout = -32001,
    RendererUnavailable = -32003,
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

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

function waitForRenderer(): Promise<boolean> {
    if (rendererReady) return Promise.resolve(true);
    return new Promise(resolve => {
        const resolver = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => {
            const idx = readyWaiters.indexOf(resolver);
            if (idx >= 0) readyWaiters.splice(idx, 1);
            resolve(false);
        }, RENDERER_READY_TIMEOUT_MS);
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
const pending = new Map<number, { clientId: number | string | null; resolve: (response: MCPResponse | null) => void; timer: ReturnType<typeof setTimeout> }>();

const stats: ServerStats = { startedAt: 0, requests: 0, success: 0, errors: 0, timeouts: 0 };

const PRIORITY: Readonly<Record<string, number>> = {
    initialize: 0,
    "tools/list": 1,
    "tools/call": 2,
};

function readBody(req: IncomingMessage): Promise<string> {
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
        ...CORS_HEADERS,
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
    pending.forEach(({ clientId, resolve, timer }) => { clearTimeout(timer); resolve(makeError(clientId, RPCError.InternalError, reason)); });
    pending.clear();
    requestQueue.length = 0;
}

export function getNextRequest(): IPCMCPRequest | null {
    if (!requestQueue.length) return null;

    let bestIdx = 0;
    for (let i = 1; i < requestQueue.length; i++) {
        if (requestQueue[i].priority < requestQueue[bestIdx].priority) bestIdx = i;
    }

    const [item] = requestQueue.splice(bestIdx, 1);
    return { id: item.id, request: item.request };
}

export function sendResponse(_event: IpcMainInvokeEvent, id: number, response: MCPResponse | null): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
}

export function startServer(): { ok: boolean; port: number } {
    clearPending("Server restarting");

    if (server) return { ok: true, port: PORT };

    server = createServer(async (req, res) => {
        stats.requests++;

        const { origin } = req.headers;
        if (origin && !LOCAL_ORIGIN_RE.test(origin)) {
            stats.errors++;
            res.writeHead(403, CORS_HEADERS);
            res.end();
            return;
        }

        if (req.method === "OPTIONS") {
            res.writeHead(204, { ...CORS_HEADERS, "Access-Control-Max-Age": String(CORS_PREFLIGHT_MAX_AGE_SECONDS) });
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
                sendError(res, request.id ?? null, RPCError.RendererUnavailable, `Renderer did not become ready within ${RENDERER_READY_TIMEOUT_MS / 1000}s`);
                return;
            }
        }

        const id = (requestId = (requestId + 1) & REQUEST_ID_MASK);
        const priority = PRIORITY[request.method] ?? DEFAULT_REQUEST_PRIORITY;
        const params = request.params as ToolCallParams | undefined;
        const action = params?.arguments?.action as string | undefined;
        const timeout = request.method === "tools/call" && params?.name ? getToolTimeout(params.name, action) : DEFAULT_TIMEOUT_MS;

        const response = await new Promise<MCPResponse | null>(resolve => {
            pending.set(id, {
                clientId: request.id ?? null,
                resolve,
                timer: setTimeout(() => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    stats.timeouts++;

                    const tool = params?.name ?? request.method;
                    const detail = action ? `${tool}:${action}` : tool;

                    resolve(
                        makeError(request.id ?? null, RPCError.Timeout, `${detail} did not respond within ${Math.round(timeout / 1000)}s. The renderer may be blocked or the operation is too expensive.`, {
                            tool,
                            action: action ?? null,
                            timeoutMs: timeout,
                        }),
                    );
                }, timeout),
            });

            requestQueue.push({ id, request, priority });
        });

        if (response === null) {
            res.writeHead(204, CORS_HEADERS);
            res.end();
        } else {
            if (!("error" in response)) stats.success++;
            else if (response.error?.code !== RPCError.Timeout) stats.errors++;
            writeJSON(res, 200, JSON.stringify(response));
        }
    });

    server.keepAliveTimeout = SERVER_KEEPALIVE_TIMEOUT_MS;
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.maxHeadersCount = SERVER_MAX_HEADERS;
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

const KEYMAP_MAX_BYTES = 2_000_000;

function keyMapPath(): string {
    return join(app.getPath("userData"), "EquicordMcpKeyMap.json");
}

export async function readKeyMap(): Promise<string | null> {
    try {
        const text = await fs.readFile(keyMapPath(), "utf8");
        return text.length <= KEYMAP_MAX_BYTES ? text : null;
    } catch {
        return null;
    }
}

export async function writeKeyMap(_event: IpcMainInvokeEvent, json: string): Promise<{ ok: boolean }> {
    if (typeof json !== "string" || json.length > KEYMAP_MAX_BYTES) return { ok: false };
    try {
        const path = keyMapPath();
        await fs.writeFile(path + ".tmp", json, "utf8");
        await fs.rename(path + ".tmp", path);
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

export function getServerStatus(): ServerStatus {
    const uptime = stats.startedAt ? Date.now() - stats.startedAt : 0;
    return {
        running: server !== null,
        port: PORT,
        stats: {
            ...stats,
            pendingRequests: pending.size,
            queuedRequests: requestQueue.length,
            uptimeFormatted: uptime ? `${Math.floor(uptime / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s` : null,
        },
    };
}
