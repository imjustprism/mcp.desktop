/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxToolArgs } from "../types";
import { FluxDispatcher, getFluxDispatcherInternal } from "../webpack";
import { LIMITS } from "./constants";
import * as u from "./utils";

export async function handleFluxTool(args: FluxToolArgs): Promise<unknown> {
    const { action, event, type, payload, filter: filterPattern } = args;
    const limit = u.clamp(args.limit, LIMITS.FLUX.SLICE, 1, 1000);

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
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;

        if (nodes) {
            for (const nodeId in nodes) {
                if (nodes[nodeId].actionHandler?.[event]) {
                    const name = nodes[nodeId].name ?? nodeId;
                    if (!seen.has(name)) { seen.add(name); storeHandlers.push(name); }
                }
            }
        }

        const orderedHandlers = dispatcher._actionHandlers?._orderedActionHandlers?.[event];
        if (orderedHandlers) {
            for (const h of orderedHandlers) {
                const name = h.name ?? "anonymous";
                if (!seen.has(name)) { seen.add(name); storeHandlers.push(name); }
            }
        }

        const subscriptions = dispatcher._subscriptions?.[event];
        const subscriptionCount = subscriptions?.size ?? 0;

        if (!storeHandlers.length && !subscriptionCount) {
            return { error: true, message: `No handlers for event: ${event}` };
        }

        return { found: true, event, storeHandlerCount: storeHandlers.length, storeHandlers: storeHandlers.slice(0, limit), subscriptionCount };
    }

    if (action === "types" || action === "events" || (!action && !event)) {
        const eventSet = new Set<string>();
        const ah = dispatcher._actionHandlers;
        const addKeys = (o: Record<string, unknown> | undefined) => { if (o) for (const k in o) eventSet.add(k); };

        for (const nodeId in ah?._dependencyGraph?.nodes ?? {}) {
            addKeys(ah!._dependencyGraph!.nodes![nodeId]?.actionHandler);
        }
        addKeys(ah?._orderedActionHandlers);
        addKeys(dispatcher._subscriptions);

        let events = [...eventSet].sort();
        if (filterPattern) {
            const regex = u.compileFilterRegex(filterPattern);
            if (!regex) {
                u.mcpLogger.warn(`flux: invalid filter regex "${filterPattern}"`);
                return { error: true, message: `Invalid filter regex: ${filterPattern}` };
            }
            events = events.filter(e => regex.test(e));
        }

        return { total: eventSet.size, filtered: events.length, events: events.slice(0, limit), note: events.length > limit ? "Use filter or limit to narrow" : undefined };
    }

    return { error: true, message: "action: events, types, dispatch, listeners" };
}
