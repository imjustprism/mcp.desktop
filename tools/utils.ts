/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getIntlMessageFromHash } from "@utils/discord";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { factoryListeners, findAll, findStore, wreq } from "@webpack";
import { Flux, FluxDispatcher, i18n } from "@webpack/common";
import { WebpackPatcher } from "Vencord";

import keyMapJson from "../map/key_map.json";
import {
    ActiveTrace,
    BatchResult,
    ComponentInfo,
    FiberMemoizedState,
    FluxAction,
    FluxDispatcherInternal,
    FunctionIntercept,
    ModuleWatch,
    PluginPatch,
    PluginReplacement,
    ReactFiber,
    WebpackModule,
} from "../types";

const KEY_MAP: Record<string, string> = keyMapJson;
const { getFactoryPatchedSource, getFactoryPatchedBy } = WebpackPatcher;

const regexCache = new Map<string, RegExp>();

export function getCachedRegex(pattern: string, flags = ""): RegExp {
    const key = `${pattern}\0${flags}`;
    let regex = regexCache.get(key);
    if (!regex) {
        if (regexCache.size >= 100) regexCache.delete(regexCache.keys().next().value!);
        regex = new RegExp(pattern, flags);
        regexCache.set(key, regex);
    }
    return regex;
}

let moduleIdCache: string[] | null = null;
let moduleIdCacheTime = 0;

export function getModuleIds(): string[] {
    const now = Date.now();
    if (!moduleIdCache || now - moduleIdCacheTime > 5000) {
        moduleIdCache = Object.keys(wreq.m);
        moduleIdCacheTime = now;
    }
    return moduleIdCache;
}

export function invalidateModuleIdCache(): void {
    moduleIdCache = null;
}

const batchResultsCache = new Map<string, BatchResult>();
let batchCacheTime = 0;

export function clearBatchResultsCache(): void {
    batchResultsCache.clear();
}

const moduleSourceCache = new Map<string, string>();
let cacheTimestamp = 0;

export function getModuleSource(id: string): string {
    const now = Date.now();
    if (now - cacheTimestamp > 60000) {
        moduleSourceCache.clear();
        cacheTimestamp = now;
    }

    let source = moduleSourceCache.get(id);
    if (!source) {
        const factory = wreq.m[id];
        if (!factory) return "";
        const code = String(factory);
        const isArrow = code.startsWith("(");
        source = "0," + (isArrow ? "" : "function") + code.slice(code.indexOf("("));
        moduleSourceCache.set(id, source);
    }
    return source;
}

export function clearModuleSourceCache(): void {
    moduleSourceCache.clear();
}

export function countModuleMatchesFast(str: string, earlyExit = 10): number {
    if (!str || str.length < 3) return 0;

    const cached = batchResultsCache.get(str);
    if (cached) return Math.min(cached.count, earlyExit);

    let count = 0;
    const moduleIds: string[] = [];
    const ids = getModuleIds();

    for (let i = 0; i < ids.length && count < earlyExit; i++) {
        const source = getModuleSource(ids[i]);
        if (source.includes(str)) {
            count++;
            if (moduleIds.length < 5) moduleIds.push(ids[i]);
        }
    }

    batchResultsCache.set(str, { count, moduleIds });
    return count;
}

export function batchCountModuleMatches(strings: string[], earlyExit = 10): Map<string, BatchResult> {
    const now = Date.now();
    if (now - batchCacheTime > 60000) {
        batchResultsCache.clear();
        batchCacheTime = now;
    }

    const results = new Map<string, BatchResult>();
    const toScan: string[] = [];

    for (const str of strings) {
        const cached = batchResultsCache.get(str);
        if (cached) results.set(str, cached);
        else {
            results.set(str, { count: 0, moduleIds: [] });
            toScan.push(str);
        }
    }

    if (!toScan.length) return results;

    const ids = getModuleIds();
    const remaining = new Set(toScan);

    for (let i = 0; i < ids.length && remaining.size; i++) {
        const source = getModuleSource(ids[i]);
        for (const str of remaining) {
            if (source.includes(str)) {
                const entry = results.get(str)!;
                entry.count++;
                if (entry.moduleIds.length < 5) entry.moduleIds.push(ids[i]);
                if (entry.count >= earlyExit) remaining.delete(str);
            }
        }
    }

    for (const str of toScan) batchResultsCache.set(str, results.get(str)!);
    return results;
}

export const traceState = {
    nextId: 1,
    active: new Map<number, ActiveTrace>(),
    interceptor: null as ((action: FluxAction) => boolean) | null,
};

export const interceptState = {
    nextId: 1,
    active: new Map<number, FunctionIntercept>(),
};

export const moduleWatchState = {
    nextId: 1,
    active: new Map<number, ModuleWatch>(),
    isLoadingLazy: false,
    lastLazyLoadResult: null as { loadedAt: number; modulesBefore: number; modulesAfter: number; newModules: number } | null,
};

let intlHashToKeyMap: Map<string, string> | null = null;
let localeMessagesCache: Record<string, unknown[]> | null = null;
let localeMessagesCacheTime = 0;

export function getLocaleMessages(): Record<string, unknown[]> | null {
    const now = Date.now();
    if (localeMessagesCache && now - localeMessagesCacheTime < 300000) return localeMessagesCache;

    for (const mod of Object.values(wreq.c) as WebpackModule[]) {
        const exp = mod?.exports?.default;
        if (!exp || typeof exp !== "object") continue;
        const keys = Object.keys(exp);
        if (keys.length > 10000 && keys.every(k => k.length === 6 || k.length === 7)) {
            localeMessagesCache = exp as Record<string, unknown[]>;
            localeMessagesCacheTime = now;
            return localeMessagesCache;
        }
    }
    return null;
}

export function extractIntlText(arr: unknown): string {
    if (!Array.isArray(arr)) return String(arr ?? "");
    return arr.filter(item => typeof item === "string").join("");
}

export function intlHashExistsInDefinitions(hash: string): boolean {
    if (getLocaleMessages()?.[hash]) return true;
    try {
        const msg = i18n.intl.string(i18n.t[hash]);
        return msg !== "" && msg !== hash;
    } catch {
        return false;
    }
}

export function buildIntlHashToKeyMap(): Map<string, string> {
    if (intlHashToKeyMap) return intlHashToKeyMap;
    intlHashToKeyMap = new Map();

    for (const [hash, key] of Object.entries(KEY_MAP)) intlHashToKeyMap.set(hash, key);

    const keyPattern = /#\{intl::([A-Z][A-Z0-9_]*)/g;
    const extract = (str: string) => {
        let m: RegExpExecArray | null;
        while ((m = keyPattern.exec(str))) {
            intlHashToKeyMap!.set(runtimeHashMessageKey(m[1]), m[1]);
        }
    };

    for (const id of getModuleIds()) extract(getModuleSource(id));

    for (const plugin of Object.values(Vencord.Plugins.plugins)) {
        if (!plugin.patches) continue;
        for (const patch of plugin.patches as PluginPatch[]) {
            if (typeof patch.find === "string") extract(patch.find);
            else if (patch.find instanceof RegExp) extract(patch.find.source);
            const reps = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
            for (const r of reps as PluginReplacement[]) {
                if (r?.match instanceof RegExp) extract(r.match.source);
                else if (typeof r?.match === "string") extract(r.match);
                if (typeof r?.replace === "string") extract(r.replace);
            }
        }
    }

    return intlHashToKeyMap;
}

export function getIntlKeyFromHash(hash: string): string | null {
    return buildIntlHashToKeyMap().get(hash) ?? null;
}

export function searchModulesOptimized(predicate: (source: string, id: string) => boolean, limit: number): string[] {
    const results: string[] = [];
    const ids = getModuleIds();
    for (let i = 0; i < ids.length && results.length < limit; i++) {
        const source = getModuleSource(ids[i]);
        if (source && predicate(source, ids[i])) results.push(ids[i]);
    }
    return results;
}

export function serializeResult(value: unknown, maxLength = 50000): string {
    const seen = new WeakSet();
    const parts: string[] = [];
    let length = 0;

    const write = (s: string): boolean => {
        if (length + s.length > maxLength) {
            parts.push(s.slice(0, maxLength - length));
            length = maxLength;
            return false;
        }
        parts.push(s);
        length += s.length;
        return true;
    };

    const serialize = (val: unknown, depth: number): boolean => {
        if (length >= maxLength) return false;
        if (depth > 10) return write('"[Max Depth]"');
        if (val === null || val === undefined) return write("null");

        const type = typeof val;
        if (type === "string") {
            const escaped = JSON.stringify(val);
            return write(escaped.length > 1000 ? escaped.slice(0, 1000) + '..."' : escaped);
        }
        if (type === "number" || type === "boolean") return write(String(val));
        if (type === "bigint") return write(`"${val}n"`);
        if (type === "symbol") return write(`"${val.toString()}"`);
        if (type === "function") {
            const str = (val as () => void).toString();
            return write(JSON.stringify(str.length > 500 ? str.slice(0, 500) + "..." : str));
        }

        if (type === "object") {
            if (seen.has(val as object)) return write('"[Circular]"');
            seen.add(val as object);

            if (val instanceof RegExp) return write(`"${val.toString()}"`);
            if (val instanceof Error) {
                write('{"error":');
                write(JSON.stringify(val.message));
                if (val.stack) {
                    write(',"stack":');
                    write(JSON.stringify(val.stack.slice(0, 500)));
                }
                return write("}");
            }
            if (val instanceof Map) return serialize(Object.fromEntries(val), depth);
            if (val instanceof Set) return serialize([...val].slice(0, 50), depth);

            if (Array.isArray(val)) {
                if (!write("[")) return false;
                const len = Math.min(val.length, 100);
                for (let i = 0; i < len; i++) {
                    if (i > 0 && !write(",")) return false;
                    if (!serialize(val[i], depth + 1)) return false;
                }
                return write("]");
            }

            if (!write("{")) return false;
            const keys = Object.keys(val).filter(k => (val as Record<string, unknown>)[k] !== undefined);
            const len = Math.min(keys.length, 50);
            for (let i = 0; i < len; i++) {
                if (i > 0 && !write(",")) return false;
                if (!write(JSON.stringify(keys[i]) + ":")) return false;
                if (!serialize((val as Record<string, unknown>)[keys[i]], depth + 1)) return false;
            }
            return write("}");
        }

        return write(String(val));
    };

    try {
        serialize(value, 0);
        return length >= maxLength ? parts.join("") + "\n... [truncated]" : parts.join("");
    } catch {
        return String(value);
    }
}

export function extractModule(id: PropertyKey, patched = true): string {
    if (patched) {
        const patchedSource = getFactoryPatchedSource(id);
        if (patchedSource) return patchedSource;
    }

    const source = getModuleSource(String(id));
    if (!source) throw new Error(`Module not found: ${String(id)}`);
    return source;
}

export function getModulePatchedBy(id: PropertyKey): string[] {
    return [...getFactoryPatchedBy(id) ?? []];
}

export function getAllStoreNames(): string[] {
    return Flux.Store.getAll()
        .map(s => s.getName())
        .filter(nm => nm.length > 2 && /^[A-Z]/.test(nm))
        .sort();
}

const TOOL_TIMEOUTS: Record<string, number> = {
    trace: 120000,
    intercept: 120000,
    module: 60000,
    intl: 60000,
};

export function getAdaptiveTimeout(toolName: string, args?: Record<string, unknown>): number {
    if (toolName === "module" && args?.action === "loadLazy") return 120000;
    if (toolName === "intl" && args?.action === "bruteforce") return 300000;
    return TOOL_TIMEOUTS[toolName] ?? 5000;
}

export function recordMetric(_toolName: string, _elapsed: number): void { }

export function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`"${toolName}" timed out (${ms}ms)`)), ms);
        })
    ]);
}

export function parseRegex(pattern: string): RegExp | null {
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const lastSlash = pattern.lastIndexOf("/");
        return getCachedRegex(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
    }
    return null;
}

export function cleanupIntercept(id: number): boolean {
    const intercept = interceptState.active.get(id);
    if (!intercept) return false;

    const mod = wreq.c[intercept.moduleId] as WebpackModule | undefined;
    if (mod?.exports) {
        try {
            if (intercept.exportKey === "module") {
                Object.defineProperty(wreq.c, intercept.moduleId, { value: { exports: intercept.original }, configurable: true, writable: true });
            } else {
                Object.defineProperty(mod.exports, intercept.exportKey, { value: intercept.original, configurable: true, writable: true });
            }
        } catch { }
    }
    interceptState.active.delete(id);
    return true;
}

export function cleanupExpiredIntercepts(): void {
    const now = Date.now();
    for (const [id, intercept] of interceptState.active) {
        if (now >= intercept.expiresAt) cleanupIntercept(id);
    }
}

export function cleanupAllIntercepts(): void {
    for (const id of interceptState.active.keys()) cleanupIntercept(id);
}

export function cleanupTrace(id: number): boolean {
    const trace = traceState.active.get(id);
    if (!trace) return false;

    trace.unsub?.();
    traceState.active.delete(id);

    if (!traceState.active.size && traceState.interceptor) {
        const dispatcher = FluxDispatcher as unknown as FluxDispatcherInternal;
        const idx = dispatcher._interceptors?.indexOf(traceState.interceptor);
        if (idx !== undefined && idx >= 0) dispatcher._interceptors?.splice(idx, 1);
        traceState.interceptor = null;
    }
    return true;
}

export function cleanupExpiredTraces(): void {
    const now = Date.now();
    for (const [id, trace] of traceState.active) {
        if (now >= trace.expiresAt) cleanupTrace(id);
    }
}

export function cleanupAllTraces(): void {
    for (const id of traceState.active.keys()) cleanupTrace(id);
}

export function cleanupModuleWatch(id: number): boolean {
    const watch = moduleWatchState.active.get(id);
    if (!watch) return false;
    if (watch.listener) factoryListeners.delete(watch.listener);
    moduleWatchState.active.delete(id);
    return true;
}

export function cleanupExpiredModuleWatches(): void {
    const now = Date.now();
    for (const [id, watch] of moduleWatchState.active) {
        if (now >= watch.expiresAt) cleanupModuleWatch(id);
    }
}

export function cleanupAllModuleWatches(): void {
    for (const id of moduleWatchState.active.keys()) cleanupModuleWatch(id);
}

const FIBER_TAGS: Readonly<Record<number, string>> = {
    0: "Function", 1: "Class", 2: "Indeterminate", 3: "HostRoot", 4: "Portal",
    5: "DOM", 6: "Text", 7: "Fragment", 8: "Mode", 9: "ContextConsumer",
    10: "ContextProvider", 11: "ForwardRef", 12: "Profiler", 13: "Suspense",
    14: "Memo", 15: "SimpleMemo", 16: "Lazy", 17: "IncompleteClass",
    18: "DehydratedFragment", 19: "SuspenseList", 20: "Scope",
    21: "Offscreen", 22: "LegacyHidden", 23: "Cache", 24: "TracingMarker",
    25: "HostHoistable", 26: "HostSingleton", 27: "HostResource"
};

export function getFiber(el: Element): ReactFiber | null {
    for (const key in el) {
        if (key.startsWith("__reactFiber$")) return (el as unknown as Record<string, ReactFiber>)[key];
    }
    return null;
}

export function getComponentName(fiber: ReactFiber | null): string | null {
    const type = fiber?.type;
    if (!type) return null;
    if (type.displayName) return type.displayName;
    if (typeof type.name === "string" && type.name.length > 1) return type.name;
    return null;
}

export function getComponentInfo(fiber: ReactFiber | null): ComponentInfo {
    const tag = fiber?.tag ?? 0;
    const type = fiber?.type;
    const tagType = FIBER_TAGS[tag] ?? `Tag${tag}`;
    const key = fiber?.key ?? null;

    if (!type) return { name: null, tagType, isMinified: false, key };
    if (type.displayName) return { name: type.displayName, tagType, isMinified: false, key };
    if (typeof type === "string") return { name: type as string, tagType, isMinified: false, key };
    if (typeof type.name === "string" && type.name.length > 2) return { name: type.name, tagType, isMinified: false, key };
    if (type.render?.displayName) return { name: type.render.displayName, tagType, isMinified: false, key };
    if (type.WrappedComponent?.displayName) return { name: `Wrapped(${type.WrappedComponent.displayName})`, tagType, isMinified: false, key };

    return { name: null, tagType, isMinified: typeof type.name === "string" && type.name.length <= 2, key };
}

export function serializeValue(val: unknown, d = 0): unknown {
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (d > 3) return typeof val;

    const t = typeof val;
    if (t === "function") return `[fn:${(val as { name?: string }).name || "anon"}]`;
    if (t !== "object") return val;
    if (Array.isArray(val)) return d < 2 && val.length <= 3 ? val.map(v => serializeValue(v, d + 1)) : `[${val.length}]`;

    const obj = val as Record<string, unknown>;
    if ("$$typeof" in obj) return "[Element]";

    const keys = Object.keys(obj);
    if (!keys.length) return "{}";
    if (d < 2 && keys.length <= 4) {
        const result: Record<string, unknown> = {};
        for (const k of keys) result[k] = serializeValue(obj[k], d + 1);
        return result;
    }
    return `{${keys.slice(0, 4).join(",")}}`;
}

export function getHookType(hook: FiberMemoizedState): string {
    if (hook.queue?.dispatch) {
        return hook.queue.lastRenderedReducer?.name === "basicStateReducer" ? "useState" : "useReducer";
    }

    const ms = hook.memoizedState;
    if (ms && typeof ms === "object") {
        const mso = ms as Record<string, unknown>;
        if ("tag" in mso && "create" in mso) {
            const tag = mso.tag as number;
            if (tag & 4) return "useLayoutEffect";
            if (tag & 2) return "useInsertionEffect";
            if (tag & 8) return "useEffect";
            return "effect";
        }
        if ("current" in mso) return "useRef";
    }

    if (typeof ms === "function") return "useCallback";
    if (Array.isArray(hook.deps) && ms !== undefined) return "useMemo";
    if (ms && typeof ms === "object") return "useContext";
    return "unknown";
}

export { findAll, findStore, getIntlMessageFromHash, KEY_MAP, runtimeHashMessageKey };
