/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { StoreToolArgs, ToolResult } from "../types";
import { getFluxDispatcherInternal, resolveStore } from "../webpack";
import { LIMITS } from "./constants";
import { findStore, getAllStoreNames, serializeResult } from "./utils";

export async function handleStoreTool(args: StoreToolArgs): Promise<ToolResult> {
    const { action, name: storeName, method, args: methodArgs } = args;
    const depth = args.depth ?? 2;
    const includeTypes = args.includeTypes ?? false;

    if (action === "list" || (!action && !storeName)) {
        const stores = getAllStoreNames();
        return {
            count: stores.length,
            stores: stores.slice(0, LIMITS.STORE.LIST_SLICE),
            note: stores.length > LIMITS.STORE.LIST_SLICE ? "Use filter to narrow" : undefined
        };
    }

    if (!storeName) return { error: true, message: "name required for store operations" };

    const resolved = resolveStore(storeName);
    const resolvedName = resolved?.name ?? storeName;
    const store = resolved?.store ?? null;

    if (!store) {
        const validStores = getAllStoreNames();
        const lower = storeName.toLowerCase();
        const starts = validStores.filter(s => s.toLowerCase().startsWith(lower));
        const contains = validStores.filter(s => s.toLowerCase().includes(lower) && !s.toLowerCase().startsWith(lower));
        const suggestions = [...starts, ...contains].slice(0, LIMITS.STORE.SUGGESTIONS);

        const looksLikeMethod = /^[a-z]/.test(storeName) || storeName.includes("(");
        const methodMatches: Array<{ store: string; method: string }> = [];
        if (!suggestions.length || looksLikeMethod) {
            const methodLower = lower.replace(/[()]/g, "");
            for (const sn of validStores) {
                if (methodMatches.length >= LIMITS.STORE.METHOD_MATCHES) break;
                try {
                    const s = findStore(sn as Parameters<typeof findStore>[0]) as Record<string, unknown>;
                    const proto = Object.getPrototypeOf(s);
                    const names = [...Object.getOwnPropertyNames(proto), ...Object.getOwnPropertyNames(s)];
                    for (const nm of names) {
                        if (nm.toLowerCase().includes(methodLower)) {
                            methodMatches.push({ store: sn, method: nm });
                            break;
                        }
                    }
                } catch { continue; }
            }
        }

        if (methodMatches.length) {
            return { error: true, message: `Store "${storeName}" not found`, methodMatches, suggestions: !looksLikeMethod && suggestions.length ? suggestions : undefined };
        }

        return { error: true, message: `Store "${storeName}" not found`, suggestions: suggestions.length ? suggestions : undefined };
    }

    const dispatcher = getFluxDispatcherInternal();

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

        const cap = (v: unknown) => typeof v === "object" && v !== null ? serializeResult(v, LIMITS.STORE.SERIALIZE_CALL) : v;
        const typeOf = (v: unknown) => v === null ? "null" : v === undefined ? "undefined" : Array.isArray(v) ? "array" : typeof v;

        if (desc?.get) {
            try {
                const value = desc.get.call(store);
                return { found: true, property: method, isGetter: true, value: cap(value), valueType: typeOf(value) };
            } catch (e) {
                return { found: true, property: method, isGetter: true, error: `Getter threw: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        const fn = store[method];
        if (typeof fn === "function") {
            try {
                const value = (fn as (...args: unknown[]) => unknown).apply(store, methodArgs ?? []);
                return { found: true, method, value: cap(value), valueType: typeOf(value) };
            } catch (e) {
                return { found: true, method, error: `Method threw: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        if (fn !== undefined) return { found: true, property: method, value: cap(fn), valueType: typeof fn };
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
        displayName: resolvedName,
        methods: methods.sort(),
        getters: getters.sort(),
        properties: properties.sort()
    };
}
