import { FluxToolArgs, ToolResult } from "../types";
import { FluxDispatcher, getFluxDispatcherInternal, resolveStore } from "../webpack";
import { LIMITS } from "./constants";
import * as u from "./utils";

export async function handleFlux(args: FluxToolArgs): Promise<ToolResult> {
    const { action, event, type, store, payload, filter: filterPattern } = args;
    const limit = u.clamp(args.limit, LIMITS.FLUX.SLICE, 1, LIMITS.FLUX.MAX_LIMIT);

    const dispatcher = getFluxDispatcherInternal();

    if (action === "dispatch") {
        if (!type) return u.missingArg("type");
        FluxDispatcher.dispatch({ ...payload, type });
        return { dispatched: true, type };
    }

    if (action === "listeners") {
        if (!event) return u.missingArg("event");

        const storeHandlers: string[] = [];
        const seen = new Set<string>();
        const add = (name: string) => { if (!seen.has(name)) { seen.add(name); storeHandlers.push(name); } };
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;

        if (nodes) for (const nodeId in nodes) {
            const { actionHandler, name } = nodes[nodeId];
            if (actionHandler && Object.hasOwn(actionHandler, event)) add(name ?? nodeId);
        }

        const om = dispatcher._actionHandlers?._orderedActionHandlers;
        if (om && Object.hasOwn(om, event)) for (const h of om[event]) add(h.name ?? "anonymous");

        const subs = dispatcher._subscriptions;
        const subscriptionCount = subs && Object.hasOwn(subs, event) ? subs[event]?.size ?? 0 : 0;

        if (!storeHandlers.length && !subscriptionCount) {
            return { error: true, message: `No handlers for event: ${event}` };
        }

        return { found: true, event, storeHandlerCount: storeHandlers.length, storeHandlers: storeHandlers.slice(0, limit), subscriptionCount };
    }

    if (action === "events" || (!action && !event)) {
        const eventSet = new Set<string>();
        const ah = dispatcher._actionHandlers;
        const addKeys = (o: Record<string, unknown> | undefined) => { if (o) for (const k in o) eventSet.add(k); };

        const depNodes = ah?._dependencyGraph?.nodes;
        if (depNodes) for (const nodeId in depNodes) addKeys(depNodes[nodeId]?.actionHandler);
        addKeys(ah?._orderedActionHandlers);
        addKeys(dispatcher._subscriptions);

        let events = [...eventSet].sort();
        if (filterPattern) {
            const regex = u.compileFilterRegexOrError(filterPattern, "flux");
            if ("error" in regex) return regex;
            events = events.filter(e => regex.test(e));
        }

        return { total: eventSet.size, filtered: events.length, events: events.slice(0, limit), note: events.length > limit ? "Use filter or limit to narrow" : undefined };
    }

    if (action === "graph") {
        if (!store) return u.missingArg("store");
        const resolved = resolveStore(store);
        if (!resolved) return { error: true, message: `Store "${store}" not found` };
        const token = resolved.store._dispatchToken;
        if (typeof token !== "string") return { error: true, message: `Store "${resolved.name}" has no dispatch token` };
        const dg = dispatcher._actionHandlers?._dependencyGraph;
        const node = dg?.nodes?.[token];
        if (!node) return { error: true, message: `No dispatch node for "${resolved.name}" (token ${token})` };
        const resolveNames = (toks: string[] | undefined) => (toks ?? []).filter(t => !t.startsWith("band.")).map(t => dg?.nodes?.[t]?.name ?? t);
        const dependsOn = resolveNames(dg?.outgoingEdges?.[token]);
        const dependents = resolveNames(dg?.incomingEdges?.[token]);
        return {
            store: resolved.name,
            token,
            band: node.band,
            handles: Object.keys(node.actionHandler ?? {}),
            dependsOn,
            dependentCount: dependents.length,
            dependents: dependents.slice(0, limit),
        };
    }

    if (action === "producers") {
        if (!type) return u.missingArg("type");
        const ids = u.findModuleIds(src => src.includes(`type:"${type}"`) || src.includes(`type: "${type}"`), limit);
        return { type, count: ids.length, producers: ids.map(id => ({ moduleId: id, hint: u.getModuleHint(id) })) };
    }

    if (action === "chain") {
        if (!type) return u.missingArg("type");
        const ah = dispatcher._actionHandlers;
        const getOrdered = ah?.getOrderedActionHandlers;
        if (typeof getOrdered !== "function") return { error: true, message: "getOrderedActionHandlers unavailable" };
        const ordered = u.safeCall<Array<{ name?: string }>>(() => getOrdered.call(ah, { type }), []);
        if (!Array.isArray(ordered)) return { error: true, message: `No handler chain for "${type}"` };
        const bandByName: Record<string, number | undefined> = Object.create(null);
        const nodes = ah?._dependencyGraph?.nodes ?? {};
        for (const tok in nodes) { const n = nodes[tok]; if (n?.name) bandByName[n.name] = n.name in bandByName && bandByName[n.name] !== n.band ? undefined : n.band; }
        const chain = ordered.slice(0, limit).map((h, i) => ({ order: i, store: h.name ?? "anonymous", band: h.name ? bandByName[h.name] : undefined }));
        return { type, handlerCount: ordered.length, truncated: ordered.length > limit ? true : undefined, chain };
    }

    return { error: true, message: "action: events, dispatch, listeners, graph, producers, chain" };
}
