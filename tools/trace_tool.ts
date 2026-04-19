/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FluxStore } from "@vencord/discord-types";

import { ActiveTrace, FluxAction, TraceCapture, TraceToolArgs } from "../types";
import { getFluxDispatcherInternal, resolveStore } from "../webpack";
import { LIMITS } from "./constants";
import * as u from "./utils";

function summarizeCaptures(captures: TraceCapture[], limit: number) {
    const typeCounts: Record<string, number> = {};
    for (const c of captures) typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;

    const sliced = captures.slice(0, limit).map(c => {
        if (!c.data) return c;
        const serialized = u.serializeResult(c.data, LIMITS.TRACE.SUMMARIZE_SERIALIZE);
        return { ts: c.ts, type: c.type, data: serialized.length > LIMITS.TRACE.SUMMARIZE_TEXT_SLICE ? serialized.slice(0, LIMITS.TRACE.SUMMARIZE_TEXT_SLICE) + "..." : serialized };
    });

    return { typeCounts, captures: sliced, truncated: captures.length > limit ? true : undefined };
}

export async function handleTraceTool(args: TraceToolArgs): Promise<unknown> {
    const { action, id: traceId, filter } = args;
    const duration = u.clamp(args.duration, 10000, 1000, 60000);
    const maxCaptures = Math.min(args.maxCaptures ?? 100, 500);
    const limit = args.limit ?? LIMITS.TRACE.HANDLER_SLICE;

    const dispatcher = getFluxDispatcherInternal();
    u.cleanupExpiredTraces();

    if (action === "events") {
        const events = new Set<string>();
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;

        if (nodes) {
            for (const nodeId in nodes) {
                for (const event in nodes[nodeId].actionHandler) events.add(event);
            }
        }
        if (dispatcher._subscriptions) {
            for (const event in dispatcher._subscriptions) events.add(event);
        }

        let eventList = [...events].sort();
        if (filter) {
            const regex = u.compileFilterRegex(filter);
            if (!regex) {
                u.mcpLogger.warn(`trace: invalid filter regex "${filter}"`);
                return { error: true, message: `Invalid filter regex: ${filter}` };
            }
            eventList = eventList.filter(e => regex.test(e));
        }

        return {
            total: events.size,
            filtered: eventList.length,
            events: eventList.slice(0, limit),
            note: eventList.length > limit ? "Use filter to narrow" : undefined,
        };
    }

    if (action === "handlers") {
        const eventName = args.event;
        if (!eventName) return u.missingArg("event");

        const ordered = dispatcher._actionHandlers?._orderedActionHandlers?.[eventName];
        const subscriptions = dispatcher._subscriptions?.[eventName];
        const storeNames = ordered?.map(h => h.name ?? "anonymous") ?? [];

        return {
            event: eventName,
            storeHandlerCount: storeNames.length,
            storeHandlers: storeNames.slice(0, LIMITS.TRACE.HANDLER_SLICE),
            subscriptionCount: subscriptions?.size ?? 0,
        };
    }

    if (action === "storeEvents") {
        if (!args.store) return u.missingArg("store");

        const resolved = resolveStore(args.store);
        if (!resolved) return { error: true, message: `Store "${args.store}" not found` };
        const { name: storeName } = resolved;
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;
        const events: string[] = [];

        if (nodes) {
            for (const nodeId in nodes) {
                if (nodes[nodeId].name === storeName) {
                    events.push(...Object.keys(nodes[nodeId].actionHandler ?? {}));
                }
            }
        }

        return { store: storeName, eventCount: events.length, events: events.sort() };
    }

    if (action === "start" || (!action && filter)) {
        let filterRegex: RegExp | null = null;
        if (filter) {
            filterRegex = u.compileFilterRegex(filter);
            if (!filterRegex) {
                u.mcpLogger.warn(`trace: invalid filter regex "${filter}"`);
                return { error: true, message: `Invalid filter regex: ${filter}` };
            }
        }
        const id = u.traceState.nextId++;
        const now = Date.now();

        const trace: ActiveTrace = {
            id,
            filter: filterRegex,
            captures: [],
            maxCaptures,
            startedAt: now,
            expiresAt: now + duration,
            unsub: null,
        };

        if (!u.traceState.interceptor) {
            if (typeof dispatcher.addInterceptor !== "function") {
                u.mcpLogger.error("trace: FluxDispatcher.addInterceptor unavailable");
                return { error: true, message: "FluxDispatcher.addInterceptor unavailable; traces cannot be registered" };
            }
            const interceptor = (fluxAction: FluxAction) => {
                const ts = Date.now();
                const expired: number[] = [];
                for (const [tid, t] of u.traceState.active) {
                    if (t.isStoreTrace) continue;
                    if (ts >= t.expiresAt) { expired.push(tid); continue; }
                    if (t.captures.length >= t.maxCaptures) continue;
                    if (t.filter && !t.filter.test(fluxAction.type)) continue;

                    const { type, ...payload } = fluxAction;
                    const hasData = Object.keys(payload).some(k => {
                        const v = payload[k];
                        return v !== undefined && v !== null && !(Array.isArray(v) && !v.length);
                    });
                    t.captures.push(hasData ? { ts, type, data: payload } : { ts, type });
                }
                for (const tid of expired) u.cleanupTrace(tid);
                return false;
            };
            dispatcher.addInterceptor(interceptor);
            u.traceState.interceptor = interceptor;
        }

        u.traceState.active.set(id, trace);
        return { id, filter: filter ?? "*", duration, maxCaptures };
    }

    if (action === "get") {
        if (traceId === undefined) {
            const traces = [...u.traceState.active.values()].map(t => ({
                id: t.id,
                filter: t.filter?.source ?? "*",
                captureCount: t.captures.length,
                maxCaptures: t.maxCaptures,
                elapsed: Date.now() - t.startedAt,
                remaining: Math.max(0, t.expiresAt - Date.now()),
            }));
            return { activeTraces: traces.length, traces };
        }

        const trace = u.traceState.active.get(traceId);
        if (!trace) return { error: true, message: `Trace ${traceId} not found or expired` };

        const remaining = Math.max(0, trace.expiresAt - Date.now());
        const summary = summarizeCaptures(trace.captures, LIMITS.TRACE.GET_CAPTURE_SLICE);

        return {
            id: traceId,
            captureCount: trace.captures.length,
            remaining,
            ...summary,
        };
    }

    if (action === "stop") {
        if (traceId === undefined) {
            const count = u.traceState.active.size;
            u.cleanupAllTraces();
            return { stopped: count };
        }

        const trace = u.traceState.active.get(traceId);
        if (!trace) return { error: true, message: `Trace ${traceId} not found` };

        const { captures } = trace;
        u.cleanupTrace(traceId);
        const summary = summarizeCaptures(captures, LIMITS.TRACE.STOP_CAPTURE_SLICE);
        return { id: traceId, stopped: true, captureCount: captures.length, ...summary };
    }

    if (action === "store") {
        if (!args.store) return u.missingArg("store");

        const resolved = resolveStore(args.store);
        if (!resolved) return { error: true, message: `Store "${args.store}" not found` };
        const storeName = resolved.name;
        const store = resolved.store as any as FluxStore;
        const id = u.traceState.nextId++;
        const now = Date.now();

        const trace: ActiveTrace = {
            id,
            filter: null,
            captures: [],
            maxCaptures,
            startedAt: now,
            expiresAt: now + duration,
            unsub: null,
            isStoreTrace: true,
        };

        const handler = () => {
            if (trace.captures.length >= trace.maxCaptures) return;
            trace.captures.push({ ts: Date.now(), type: `${storeName}:change`, data: { event: "stateChanged" } });
        };

        store.addChangeListener(handler);
        trace.unsub = () => store.removeChangeListener(handler);
        u.traceState.active.set(id, trace);

        return { id, store: storeName, duration, maxCaptures };
    }

    return { error: true, message: "action: events, handlers, storeEvents, start, get, stop, store" };
}
