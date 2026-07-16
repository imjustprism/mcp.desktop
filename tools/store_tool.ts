/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { StoreToolArgs, ToolResult } from "../types";
import { resolveStore } from "../webpack";
import { LIMITS } from "./constants";
import * as u from "./utils";

function capValue(v: unknown, max: number = LIMITS.STORE.SERIALIZE_CALL): unknown {
    return v !== null && typeof v === "object" ? u.serializeResult(v, max) : v;
}
function typeOf(v: unknown): string {
    if (v === null) return "null";
    return Array.isArray(v) ? "array" : typeof v;
}

export async function handleStore(args: StoreToolArgs): Promise<ToolResult> {
    const { action, name: storeName, method, args: methodArgs } = args;

    if (action === "list" || (!action && !storeName)) {
        const all = u.getAllStoreNames();
        const filtered = storeName ? u.filterBySubstring(all, storeName, s => s) : all;
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
                const s = u.safeCall<Record<string, unknown> | null>(() => u.findStore(sn), null);
                if (!s) continue;
                const nm = u.ownAndProtoNames(s, u.safeProto(s)).find(n => n.toLowerCase().includes(methodLower));
                if (nm) methodMatches.push({ store: sn, method: nm });
            }
        }

        return {
            error: true,
            message: `Store "${storeName}" not found`,
            methodMatches: methodMatches.length ? methodMatches : undefined,
            suggestions: suggestions.length && (!methodMatches.length || !looksLikeMethod) ? suggestions : undefined,
        };
    }

    if (action === "snapshot") {
        const proto = u.safeProto(store);
        const allNames = u.ownAndProtoNames(store, proto);
        const nameSet = new Set(allNames);
        const snapshot: Record<string, unknown> = {};
        let captured = 0;
        let budget = LIMITS.STORE.SNAPSHOT_TOTAL_BUDGET;
        let truncated = false;
        for (const nm of allNames) {
            if (nm === "constructor") continue;
            if (captured >= LIMITS.STORE.SNAPSHOT_MAX) { truncated = true; break; }
            if (nm.endsWith("Array") && nameSet.has(nm.slice(0, -"Array".length))) continue;
            const desc = u.getDescriptor(store, proto, nm);
            const isZeroArgGetter = !desc?.get && nm.startsWith("get") && u.safeCall(() => { const fn = store[nm]; return typeof fn === "function" && fn.length === 0; }, false);
            if (desc?.get || isZeroArgGetter) {
                if (budget <= 0) { truncated = true; break; }
                const value = u.safeCall(
                    () => capValue(desc?.get ? desc.get.call(store) : (store[nm] as () => unknown).call(store), LIMITS.STORE.SNAPSHOT_SERIALIZE),
                    "<error>",
                );
                snapshot[nm] = value;
                budget -= u.safeCall(() => JSON.stringify(value ?? null)?.length ?? 4, 4);
                captured++;
            }
        }
        return { store: resolvedName, snapshotAt: Date.now(), getterCount: captured, truncated: truncated ? true : undefined, values: snapshot };
    }

    if (action === "links") {
        const cc = store._changeCallbacks as { listeners?: { size?: number }; conditionalListeners?: { size?: number } } | undefined;
        const rcc = store._reactChangeCallbacks as { listeners?: { size?: number } } | undefined;
        const syncWiths = store._syncWiths as Array<{ store?: { getName?: () => string } }> | undefined;
        const syncsWith = (syncWiths ?? []).map(sw => u.safeCall(() => sw?.store?.getName?.() ?? "?", "?"));
        return {
            store: resolvedName,
            dispatchToken: store._dispatchToken as string | undefined,
            syncsWith,
            listenerCount: cc?.listeners?.size ?? 0,
            reactListenerCount: rcc?.listeners?.size ?? 0,
            conditionalListenerCount: cc?.conditionalListeners?.size ?? 0,
        };
    }

    if (action === "call" || action === "state") {
        if (!method) return u.missingArg("method");
        const storeProto = u.safeProto(store);
        const desc = u.getDescriptor(store, storeProto, method);

        if (desc?.get) {
            try {
                const value = desc.get.call(store);
                return { found: true, property: method, isGetter: true, value: capValue(value), valueType: typeOf(value) };
            } catch (e) {
                return { found: true, property: method, isGetter: true, error: `Getter threw: ${u.errMsg(e)}` };
            }
        }

        const fn = store[method];
        if (typeof fn === "function") {
            try {
                const value = fn.apply(store, methodArgs ?? []);
                return { found: true, method, value: capValue(value), valueType: typeOf(value) };
            } catch (e) {
                return { found: true, method, error: `Method threw: ${u.errMsg(e)}` };
            }
        }

        if (fn !== undefined) return { found: true, property: method, value: capValue(fn), valueType: typeOf(fn) };
        return { found: false, method, error: `"${method}" not found on store` };
    }

    const proto = u.safeProto(store);
    const methods: string[] = [];
    const getters: string[] = [];
    const properties: string[] = [];

    const memberFilter = method?.toLowerCase();
    for (const nm of u.ownAndProtoNames(store, proto)) {
        if (nm === "constructor") continue;
        if (memberFilter && !nm.toLowerCase().includes(memberFilter)) continue;
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
