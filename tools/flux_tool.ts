/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxToolArgs } from "../types";
import { FluxDispatcher, getFluxDispatcherInternal } from "../webpack";
import { LIMITS } from "./constants";

export async function handleFluxTool(args: FluxToolArgs): Promise<unknown> {
    const { action, event, type, payload, filter: filterPattern } = args;

    const dispatcher = getFluxDispatcherInternal();

    if (action === "dispatch") {
        if (!type) return { error: true, message: "type required for dispatch" };
        FluxDispatcher.dispatch({ type, ...payload });
        return { dispatched: true, type };
    }

    if (action === "listeners") {
        if (!event) return { error: true, message: "event required for listeners" };

        const storeHandlers: string[] = [];
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;

        if (nodes) {
            for (const nodeId in nodes) {
                if (nodes[nodeId].actionHandler?.[event]) {
                    storeHandlers.push(nodes[nodeId].name ?? nodeId);
                }
            }
        }

        const orderedHandlers = dispatcher._actionHandlers?._orderedActionHandlers?.[event];
        if (orderedHandlers) {
            for (const h of orderedHandlers) {
                const name = h.name ?? "anonymous";
                if (!storeHandlers.includes(name)) storeHandlers.push(name);
            }
        }

        const subscriptions = dispatcher._subscriptions?.[event];
        const subscriptionCount = subscriptions?.size ?? 0;

        if (!storeHandlers.length && !subscriptionCount) {
            return { error: true, message: `No handlers for event: ${event}` };
        }

        return { found: true, event, storeHandlerCount: storeHandlers.length, storeHandlers: storeHandlers.slice(0, LIMITS.FLUX.SLICE), subscriptionCount };
    }

    if (action === "types" || action === "events" || (!action && !event)) {
        const eventSet = new Set<string>();
        const actionHandlers = dispatcher._actionHandlers;

        if (actionHandlers?._dependencyGraph?.nodes) {
            for (const nodeId in actionHandlers._dependencyGraph.nodes) {
                const handler = actionHandlers._dependencyGraph.nodes[nodeId]?.actionHandler;
                if (handler) {
                    for (const evt in handler) eventSet.add(evt);
                }
            }
        }
        if (actionHandlers?._orderedActionHandlers) {
            for (const evt in actionHandlers._orderedActionHandlers) eventSet.add(evt);
        }
        if (dispatcher._subscriptions) {
            for (const evt in dispatcher._subscriptions) eventSet.add(evt);
        }

        let events = [...eventSet].sort();
        if (filterPattern) {
            const regex = new RegExp(filterPattern, "i");
            events = events.filter(e => regex.test(e));
        }

        return { total: eventSet.size, filtered: events.length, events: events.slice(0, LIMITS.FLUX.SLICE), note: events.length > LIMITS.FLUX.SLICE ? "Use filter to narrow" : undefined };
    }

    return { error: true, message: "action: events, types, dispatch, listeners" };
}
