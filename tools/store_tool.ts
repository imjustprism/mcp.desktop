/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher } from "@webpack/common";

import { FluxDispatcherInternal, StoreToolArgs, ToolResult } from "../types";
import { findStore, getAllStoreNames } from "./utils";

export async function handleStoreTool(args: StoreToolArgs): Promise<ToolResult> {
    const { action, name: storeName, method, args: methodArgs } = args;
    const depth = args.depth ?? 2;
    const includeTypes = args.includeTypes ?? false;

    if (action === "list" || (!action && !storeName)) {
        const stores = getAllStoreNames();
        return {
            count: stores.length,
            stores: stores.slice(0, 30),
            note: stores.length > 30 ? "Use filter param or search by name" : undefined
        };
    }

    if (!storeName) return { error: true, message: "name required for store operations" };

    let resolvedName = storeName;
    let store: Record<string, unknown> | null = null;

    try {
        store = findStore(storeName as Parameters<typeof findStore>[0]) as Record<string, unknown>;
    } catch {
        if (!storeName.endsWith("Store")) {
            resolvedName = storeName + "Store";
            try {
                store = findStore(resolvedName as Parameters<typeof findStore>[0]) as Record<string, unknown>;
            } catch { }
        }
    }

    if (!store) {
        const validStores = getAllStoreNames();
        const lower = storeName.toLowerCase();
        const starts = validStores.filter(s => s.toLowerCase().startsWith(lower));
        const contains = validStores.filter(s => s.toLowerCase().includes(lower) && !s.toLowerCase().startsWith(lower));
        const suggestions = [...starts, ...contains].slice(0, 10);
        return { error: true, message: `Store "${storeName}" not found`, suggestions: suggestions.length ? suggestions : undefined };
    }

    const dispatcher = FluxDispatcher as unknown as FluxDispatcherInternal;

    if (action === "subscriptions") {
        const dispatchToken = store._dispatchToken as string | undefined;
        const nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes;
        const subscriptions: string[] = [];

        if (nodes) {
            for (const nodeId in nodes) {
                if (nodes[nodeId].name === resolvedName) {
                    subscriptions.push(...Object.keys(nodes[nodeId].actionHandler ?? {}));
                }
            }
        }

        return {
            found: true,
            storeName: resolvedName,
            dispatchToken,
            subscriptionCount: subscriptions.length,
            subscriptions: [...new Set(subscriptions)].sort()
        };
    }

    if (action === "methods") {
        const levels: Array<{ level: number; methods: Array<{ name: string; type?: string }> }> = [];
        let currentProto = Object.getPrototypeOf(store);
        let level = 0;

        while (currentProto && level < depth) {
            const methodNames = Object.getOwnPropertyNames(currentProto).filter(k => k !== "constructor").sort();
            const methods: Array<{ name: string; type?: string }> = [];

            for (const nm of methodNames) {
                const entry: { name: string; type?: string } = { name: nm };
                if (includeTypes) {
                    try {
                        const val = store[nm];
                        if (typeof val === "function" && nm.startsWith("get")) {
                            const ret = (val as () => unknown).call(store);
                            entry.type = ret === null ? "null" : Array.isArray(ret) ? "array" : typeof ret;
                        } else entry.type = typeof val;
                    } catch { entry.type = "unknown"; }
                }
                methods.push(entry);
            }

            levels.push({ level, methods });
            currentProto = Object.getPrototypeOf(currentProto);
            level++;
        }

        return {
            found: true,
            store: resolvedName,
            levels,
            totalMethods: levels.reduce((acc, l) => acc + l.methods.length, 0)
        };
    }

    if ((action === "call" || action === "state") && method) {
        const desc = Object.getOwnPropertyDescriptor(store, method) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), method);

        if (desc?.get) {
            try {
                const value = desc.get.call(store);
                return {
                    found: true,
                    property: method,
                    isGetter: true,
                    value,
                    valueType: value === null ? "null" : value === undefined ? "undefined" : Array.isArray(value) ? "array" : typeof value
                };
            } catch (e) {
                return { found: true, property: method, isGetter: true, error: `Getter threw: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        const fn = store[method];
        if (typeof fn === "function") {
            try {
                const value = (fn as (...args: unknown[]) => unknown).apply(store, methodArgs ?? []);
                return {
                    found: true,
                    method,
                    value,
                    valueType: value === null ? "null" : value === undefined ? "undefined" : Array.isArray(value) ? "array" : typeof value
                };
            } catch (e) {
                return { found: true, method, error: `Method threw: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        if (fn !== undefined) return { found: true, property: method, value: fn, valueType: typeof fn };
        return { found: true, error: `"${method}" not found on store` };
    }

    const proto = Object.getPrototypeOf(store);
    const protoProps = Object.getOwnPropertyNames(proto).filter(n => n !== "constructor");
    const ownProps = Object.getOwnPropertyNames(store);
    const methods: string[] = [];
    const getters: string[] = [];
    const properties: string[] = [];

    for (const nm of [...new Set([...protoProps, ...ownProps])]) {
        const desc = Object.getOwnPropertyDescriptor(store, nm) ?? Object.getOwnPropertyDescriptor(proto, nm);
        if (desc?.get) getters.push(nm);
        else if (typeof store[nm] === "function") methods.push(nm);
        else properties.push(nm);
    }

    return {
        found: true,
        displayName: (store.constructor as { displayName?: string })?.displayName,
        methods: methods.sort(),
        getters: getters.sort(),
        properties: properties.sort()
    };
}
