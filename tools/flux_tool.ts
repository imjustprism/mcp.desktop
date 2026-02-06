/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher } from "@webpack/common";

import { FluxDispatcherInternal } from "../types";

export async function handleFluxTool(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action as string | undefined;
    const event = args.event as string | undefined;
    const type = args.type as string | undefined;
    const payload = args.payload as Record<string, unknown> | undefined;
    const filterPattern = args.filter as string | undefined;

    const dispatcher = FluxDispatcher as unknown as FluxDispatcherInternal;

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

        return { found: true, event, storeHandlerCount: storeHandlers.length, storeHandlers: storeHandlers.slice(0, 30), subscriptionCount };
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

        return { total: eventSet.size, filtered: events.length, events: events.slice(0, 30), note: events.length > 30 ? "Use filter param to narrow results" : undefined };
    }

    return { error: true, message: "action: events, types, dispatch (with type), listeners (with event)" };
}
