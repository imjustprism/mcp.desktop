/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher } from "@webpack/common";

import { ActiveTrace, FluxAction, FluxDispatcherInternal, StoreWithListeners, TraceCapture } from "../types";
import { cleanupAllTraces, cleanupExpiredTraces, cleanupTrace, findStore, serializeResult, traceState } from "./utils";

function summarizeCaptures(captures: TraceCapture[], limit: number) {
    const typeCounts: Record<string, number> = {};
    for (const c of captures) typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;

    const sliced = captures.slice(0, limit).map(c => {
        if (!c.data) return c;
        const serialized = serializeResult(c.data, 500);
        return { ts: c.ts, type: c.type, data: serialized.length > 500 ? serialized.slice(0, 500) + "..." : serialized };
    });

    return { typeCounts, captures: sliced, truncated: captures.length > limit || undefined };
}

export async function handleTraceTool(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action as string | undefined;
    const traceId = args.id as number | undefined;
    const filter = args.filter as string | undefined;
    const duration = Math.min(Math.max(args.duration as number ?? 10000, 1000), 60000);
    const maxCaptures = Math.min(args.maxCaptures as number ?? 100, 500);
    const limit = args.limit as number ?? 30;

    const dispatcher = FluxDispatcher as unknown as FluxDispatcherInternal;
    cleanupExpiredTraces();

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
            const regex = new RegExp(filter, "i");
            eventList = eventList.filter(e => regex.test(e));
        }

        return {
            total: events.size,
            filtered: eventList.length,
            events: eventList.slice(0, limit),
            note: eventList.length > limit ? "Use filter param to narrow results" : undefined
        };
    }

    if (action === "handlers") {
        const eventName = args.event as string | undefined;
        if (!eventName) return { error: true, message: "event name required for handlers action" };

        const ordered = dispatcher._actionHandlers?._orderedActionHandlers?.[eventName];
        const subscriptions = dispatcher._subscriptions?.[eventName];
        const storeNames = ordered?.map(h => h.name ?? "anonymous") ?? [];

        return {
            event: eventName,
            storeHandlerCount: storeNames.length,
            storeHandlers: storeNames.slice(0, 30),
            subscriptionCount: subscriptions?.size ?? 0
        };
    }

    if (action === "storeEvents") {
        let storeName = args.store as string | undefined;
        if (!storeName) return { error: true, message: "store name required" };

        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;
        const events: string[] = [];
        const resolvedName = !storeName.endsWith("Store") ? storeName + "Store" : storeName;

        if (nodes) {
            for (const nodeId in nodes) {
                const node = nodes[nodeId];
                if (node.name === resolvedName || node.name === storeName) {
                    events.push(...Object.keys(node.actionHandler ?? {}));
                }
            }
        }

        if (events.length && resolvedName !== storeName) storeName = resolvedName;
        return { store: storeName, eventCount: events.length, events: events.sort() };
    }

    if (action === "start" || (!action && filter)) {
        const filterRegex = filter ? new RegExp(filter, "i") : null;
        const id = traceState.nextId++;
        const now = Date.now();

        const trace: ActiveTrace = {
            id,
            filter: filterRegex,
            captures: [],
            maxCaptures,
            startedAt: now,
            expiresAt: now + duration,
            unsub: null
        };

        if (!traceState.interceptor) {
            traceState.interceptor = (fluxAction: FluxAction) => {
                const ts = Date.now();
                for (const t of traceState.active.values()) {
                    if (t.isStoreTrace) continue;
                    if (ts >= t.expiresAt || t.captures.length >= t.maxCaptures) continue;
                    if (t.filter && !t.filter.test(fluxAction.type)) continue;

                    const { type, ...payload } = fluxAction;
                    const hasData = Object.keys(payload).some(k => {
                        const v = payload[k];
                        return v !== undefined && v !== null && !(Array.isArray(v) && !v.length);
                    });
                    t.captures.push(hasData ? { ts, type, data: payload } : { ts, type });
                }
                return false;
            };
            dispatcher.addInterceptor?.(traceState.interceptor);
        }

        traceState.active.set(id, trace);
        return { id, filter: filter ?? "*", duration, maxCaptures };
    }

    if (action === "get") {
        if (traceId === undefined) {
            const traces = [...traceState.active.values()].map(t => ({
                id: t.id,
                filter: t.filter?.source ?? "*",
                captureCount: t.captures.length,
                maxCaptures: t.maxCaptures,
                elapsed: Date.now() - t.startedAt,
                remaining: Math.max(0, t.expiresAt - Date.now())
            }));
            return { activeTraces: traces.length, traces };
        }

        const trace = traceState.active.get(traceId);
        if (!trace) return { error: true, message: `Trace ${traceId} not found or expired` };

        const remaining = Math.max(0, trace.expiresAt - Date.now());
        const summary = summarizeCaptures(trace.captures, 50);

        return {
            id: traceId,
            captureCount: trace.captures.length,
            remaining,
            ...summary
        };
    }

    if (action === "stop") {
        if (traceId === undefined) {
            const count = traceState.active.size;
            cleanupAllTraces();
            return { stopped: count };
        }

        const trace = traceState.active.get(traceId);
        if (!trace) return { error: true, message: `Trace ${traceId} not found` };

        const { captures } = trace;
        cleanupTrace(traceId);
        const summary = summarizeCaptures(captures, 100);
        return { id: traceId, stopped: true, captureCount: captures.length, ...summary };
    }

    if (action === "store") {
        let storeName = args.store as string | undefined;
        if (!storeName) return { error: true, message: "store name required" };

        let foundStore: StoreWithListeners | null = null;
        try {
            foundStore = findStore(storeName as Parameters<typeof findStore>[0]) as StoreWithListeners;
        } catch {
            if (!storeName.endsWith("Store")) {
                storeName += "Store";
                try {
                    foundStore = findStore(storeName as Parameters<typeof findStore>[0]) as StoreWithListeners;
                } catch { foundStore = null; }
            }
        }
        if (!foundStore) return { error: true, message: `Store "${storeName}" not found` };

        const store = foundStore;
        const id = traceState.nextId++;
        const now = Date.now();

        const trace: ActiveTrace = {
            id,
            filter: null,
            captures: [],
            maxCaptures,
            startedAt: now,
            expiresAt: now + duration,
            unsub: null,
            isStoreTrace: true
        };

        const handler = () => {
            if (trace.captures.length >= trace.maxCaptures) return;
            trace.captures.push({ ts: Date.now(), type: `${storeName}:change`, data: { event: "stateChanged" } });
        };

        store.addChangeListener(handler);
        trace.unsub = () => store.removeChangeListener(handler);
        traceState.active.set(id, trace);

        return { id, store: storeName, duration, maxCaptures };
    }

    return { error: true, message: "action: events, handlers (with event), storeEvents (with store), start (with filter), get, stop, store" };
}
