/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { StoreToolArgs, ToolResult } from "../types";
import { getFluxDispatcherInternal, resolveStore } from "../webpack";
import { LIMITS } from "./constants";
import * as u from "./utils";

function cap(v: unknown, max: number = LIMITS.STORE.SERIALIZE_CALL): unknown {
    return u.isObject(v) ? u.serializeResult(v, max) : v;
}
function typeOf(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

export async function handleStoreTool(args: StoreToolArgs): Promise<ToolResult> {
    const { action, name: storeName, method, args: methodArgs } = args;
    const depth = args.depth ?? 2;
    const includeTypes = args.includeTypes ?? false;

    if (action === "list" || (!action && !storeName)) {
        const all = u.getAllStoreNames();
        const filtered = storeName ? u.filterByLowerIncludes(all, storeName, s => s) : all;
        return {
            count: filtered.length,
            stores: filtered.slice(0, LIMITS.STORE.LIST_SLICE),
            note: filtered.length > LIMITS.STORE.LIST_SLICE ? "Use name to narrow further" : undefined,
        };
    }

    if (!storeName) return u.missingArg("name");

    const resolved = resolveStore(storeName);
    const resolvedName = resolved?.name ?? storeName;
    const store = resolved?.store ?? null;

    if (!store) {
        const validStores = u.getAllStoreNames();
        const suggestions = u.rankedSuggestions(validStores, storeName, LIMITS.STORE.SUGGESTIONS);

        const looksLikeMethod = /^[a-z]/.test(storeName) || storeName.includes("(");
        const methodMatches: Array<{ store: string; method: string }> = [];
        if (!suggestions.length || looksLikeMethod) {
            const methodLower = storeName.toLowerCase().replace(/[()]/g, "");
            for (const sn of validStores) {
                if (methodMatches.length >= LIMITS.STORE.METHOD_MATCHES) break;
                const s = u.safeCall<Record<string, unknown> | null>(() => u.findStore(sn) as Record<string, unknown>, null);
                if (!s) continue;
                const proto = u.safeProto(s);
                const names = [...(proto ? Object.getOwnPropertyNames(proto) : []), ...Object.getOwnPropertyNames(s)];
                for (const nm of names) {
                    if (nm.toLowerCase().includes(methodLower)) {
                        methodMatches.push({ store: sn, method: nm });
                        break;
                    }
                }
            }
        }

        if (methodMatches.length) {
            return { error: true, message: `Store "${storeName}" not found`, methodMatches, suggestions: !looksLikeMethod && suggestions.length ? suggestions : undefined };
        }

        return { error: true, message: `Store "${storeName}" not found`, suggestions: suggestions.length ? suggestions : undefined };
    }

    const dispatcher = getFluxDispatcherInternal();

    if (action === "snapshot") {
        const proto = u.safeProto(store);
        const allNames = [...new Set([...(proto ? Object.getOwnPropertyNames(proto) : []), ...Object.getOwnPropertyNames(store)])];
        const snapshot: Record<string, unknown> = {};
        let captured = 0;
        for (const nm of allNames) {
            if (nm === "constructor" || captured >= LIMITS.STORE.SNAPSHOT_MAX) continue;
            const desc = u.getDescriptor(store, proto, nm);
            const isZeroArgGetter = typeof store[nm] === "function" && nm.startsWith("get") && (store[nm] as Function).length === 0;
            if (desc?.get || isZeroArgGetter) {
                snapshot[nm] = u.safeCall(
                    () => cap(desc?.get ? desc.get.call(store) : (store[nm] as () => unknown).call(store), LIMITS.STORE.SNAPSHOT_SERIALIZE),
                    "<error>",
                );
                captured++;
            }
        }
        return { store: resolvedName, snapshotAt: Date.now(), getterCount: captured, values: snapshot };
    }

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
            subscriptions: [...new Set(subscriptions)].sort(),
        };
    }

    if (action === "methods") {
        const levels: Array<{ level: number; methods: Array<{ name: string; type?: string }> }> = [];
        let currentProto = u.safeProto(store);
        let level = 0;

        while (currentProto && level < depth) {
            const methodNames = Object.getOwnPropertyNames(currentProto).filter(k => k !== "constructor").sort();
            const methods: Array<{ name: string; type?: string }> = methodNames.map(nm => {
                const entry: { name: string; type?: string } = { name: nm };
                if (includeTypes) {
                    entry.type = u.safeCall(() => {
                        const val = store[nm];
                        if (typeof val === "function" && nm.startsWith("get") && (val as Function).length === 0) {
                            return typeOf((val as () => unknown).call(store));
                        }
                        return typeof val;
                    }, "unknown");
                }
                return entry;
            });
            levels.push({ level, methods });
            currentProto = u.safeProto(currentProto);
            level++;
        }

        return {
            found: true,
            store: resolvedName,
            levels,
            totalMethods: levels.reduce((acc, l) => acc + l.methods.length, 0),
        };
    }

    if ((action === "call" || action === "state") && method) {
        const storeProto = u.safeProto(store);
        const desc = u.getDescriptor(store, storeProto, method);

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
        return { found: true, method, error: `"${method}" not found on store` };
    }

    const proto = u.safeProto(store);
    const protoProps = proto ? Object.getOwnPropertyNames(proto).filter(n => n !== "constructor") : [];
    const ownProps = Object.getOwnPropertyNames(store);
    const methods: string[] = [];
    const getters: string[] = [];
    const properties: string[] = [];

    for (const nm of new Set([...protoProps, ...ownProps])) {
        const desc = u.getDescriptor(store, proto, nm);
        if (desc?.get) getters.push(nm);
        else if (typeof store[nm] === "function") methods.push(nm);
        else properties.push(nm);
    }

    return {
        found: true,
        displayName: resolvedName,
        methods: methods.sort(),
        getters: getters.sort(),
        properties: properties.sort(),
    };
}
