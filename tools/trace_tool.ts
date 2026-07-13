import type { FluxStore } from "@vencord/discord-types";

import { ActiveTrace, FluxAction, ToolResult,TraceCapture, TraceToolArgs } from "../types";
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

export async function handleTrace(args: TraceToolArgs): Promise<ToolResult> {
    const { action, id: traceId, filter } = args;
    const duration = u.clamp(args.duration, LIMITS.TRACE.DURATION_DEFAULT_MS, LIMITS.TRACE.DURATION_MIN_MS, LIMITS.TRACE.DURATION_MAX_MS);
    const maxCaptures = Math.min(args.maxCaptures ?? LIMITS.TRACE.MAX_CAPTURES_DEFAULT, LIMITS.TRACE.MAX_CAPTURES_CAP);

    const dispatcher = getFluxDispatcherInternal();
    u.cleanupExpiredTraces();

    const newTrace = (extra?: Partial<ActiveTrace>): ActiveTrace => {
        const now = Date.now();
        return { id: u.traceState.nextId++, filter: null, captures: [], maxCaptures, startedAt: now, expiresAt: now + duration, unsub: null, ...extra };
    };

    if (action === "start" || (!action && filter)) {
        let filterRegex: RegExp | null = null;
        if (filter) {
            const r = u.compileFilterRegexOrError(filter, "trace");
            if ("error" in r) return r;
            filterRegex = r;
        }
        const trace = newTrace({ filter: filterRegex });

        if (!u.traceState.interceptor) {
            if (typeof dispatcher.addInterceptor !== "function") {
                u.mcpLogger.error("trace: FluxDispatcher.addInterceptor unavailable");
                return { error: true, message: "FluxDispatcher.addInterceptor is unavailable" };
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
                    const hasData = Object.values(payload).some(v => v != null && !(Array.isArray(v) && !v.length));
                    t.captures.push(hasData ? { ts, type, data: payload } : { ts, type });
                }
                for (const tid of expired) u.cleanupTrace(tid);
                return false;
            };
            dispatcher.addInterceptor(interceptor);
            u.traceState.interceptor = interceptor;
        }

        u.traceState.active.set(trace.id, trace);
        return { id: trace.id, filter: filterRegex?.source ?? "*", duration, maxCaptures };
    }

    if (action === "get") {
        if (traceId === undefined) {
            const traces = [...u.traceState.active.values()].map(t => ({
                id: t.id,
                filter: t.filter?.source ?? "*",
                captureCount: t.captures.length,
                maxCaptures: t.maxCaptures,
                elapsed: Date.now() - t.startedAt,
                remaining: u.remainingMs(t.expiresAt),
            }));
            return { activeTraces: traces.length, traces };
        }

        const trace = u.traceState.active.get(traceId);
        if (!trace) return { error: true, message: `Trace ${traceId} not found or expired` };

        const remaining = u.remainingMs(trace.expiresAt);
        const summary = summarizeCaptures(trace.captures, LIMITS.TRACE.GET_CAPTURE_SLICE);

        return {
            id: traceId,
            captureCount: trace.captures.length,
            remaining,
            ...summary,
        };
    }

    if (action === "stop") {
        if (traceId === undefined) return u.stopAllResult(u.traceState.active, u.cleanupAllTraces);
        return u.stopOneResult(u.traceState.active, traceId, "Trace", u.cleanupTrace, c => summarizeCaptures(c, LIMITS.TRACE.STOP_CAPTURE_SLICE));
    }

    if (action === "store") {
        if (!args.store) return u.missingArg("store");

        const resolved = resolveStore(args.store);
        if (!resolved) return { error: true, message: `Store "${args.store}" not found` };
        const storeName = resolved.name;
        const store = resolved.store as unknown as FluxStore;
        const trace = newTrace({ isStoreTrace: true });

        const handler = () => {
            if (trace.captures.length >= trace.maxCaptures) return;
            trace.captures.push({ ts: Date.now(), type: `${storeName}:change`, data: { event: "stateChanged" } });
        };

        store.addChangeListener(handler);
        trace.unsub = () => store.removeChangeListener(handler);
        u.traceState.active.set(trace.id, trace);

        return { id: trace.id, store: storeName, duration, maxCaptures };
    }

    return { error: true, message: "action: start, get, stop, store" };
}
