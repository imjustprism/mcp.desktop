/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getIntlMessageFromHash } from "@utils/discord";
import { isNonNullish } from "@utils/guards";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { Logger } from "@utils/Logger";
import { isObject, removeFromArray, tryOrElse } from "@utils/misc";
import { canonicalizeMatch } from "@utils/patches";
import * as WebpackPatcher from "@webpack/patcher";

import keyMapJson from "../map/key_map.json";
import { getToolTimeout } from "../timeouts";
import {
    ActiveTrace,
    AnchorCandidate,
    BatchResult,
    ComponentIndex,
    ComponentInfo,
    CSSClassEntry,
    CSSIndexCache,
    CSSModuleInfo,
    FiberMemoizedState,
    FluxAction,
    FunctionIntercept,
    ModuleWatch,
    PluginPatch,
    PluginReplacement,
    ReactFiber,
    StoryControl,
    StoryEntry,
    WebpackModule,
} from "../types";
import { factoryListeners, findAll, findStore, Flux, getFluxDispatcherInternal, getIconsModuleId, getUIBarrelModuleId, i18n, IconsModule, plugins, UIBarrelModule, wreq } from "../webpack";
import { CACHE_TTL, createIntlKeyPatternRegex, CSS_CLASS_RE, INTL_DETECTION, LIMITS, MANA_COMPONENT_RE, REGEX_CACHE_MAX_SIZE } from "./constants";

export const mcpLogger = new Logger("mcp", "#d97756");

const KEY_MAP: Record<string, string> = { ...keyMapJson };
const { getFactoryPatchedSource, getFactoryPatchedBy } = WebpackPatcher;

const regexCache = new Map<string, RegExp>();

export function getCachedRegex(pattern: string, flags = ""): RegExp {
    const key = `${pattern}\0${flags}`;
    let regex = regexCache.get(key);
    if (!regex) {
        if (regexCache.size >= REGEX_CACHE_MAX_SIZE) regexCache.delete(regexCache.keys().next().value!);
        regex = new RegExp(pattern, flags);
        regexCache.set(key, regex);
    }
    return regex;
}

let moduleIdCache: string[] | null = null;
let moduleIdCacheTime = 0;

export function getModuleIds(): string[] {
    const now = Date.now();
    if (!moduleIdCache || now - moduleIdCacheTime > CACHE_TTL.MODULE_IDS_MS) {
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
    if (now - cacheTimestamp > CACHE_TTL.MODULE_SOURCE_MS) {
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
    if (cached && cached.count < cached.scannedTo) return Math.min(cached.count, earlyExit);

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

    batchResultsCache.set(str, { count, moduleIds, scannedTo: earlyExit });
    return count;
}

export function batchCountModuleMatches(strings: string[], earlyExit = 10): Map<string, BatchResult> {
    const now = Date.now();
    if (now - batchCacheTime > CACHE_TTL.BATCH_COUNT_MS) {
        batchResultsCache.clear();
        batchCacheTime = now;
    }

    const results = new Map<string, BatchResult>();
    const toScan: string[] = [];

    for (const str of strings) {
        const cached = batchResultsCache.get(str);
        if (cached && cached.count < cached.scannedTo) results.set(str, cached);
        else {
            results.set(str, { count: 0, moduleIds: [], scannedTo: earlyExit });
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

export function clearIntlCache(): void {
    intlHashToKeyMap = null;
}

export function addToKeyMap(entries: Record<string, string>): number {
    let added = 0;
    for (const [hash, key] of Object.entries(entries)) {
        if (!(hash in KEY_MAP)) {
            (KEY_MAP as Record<string, string>)[hash] = key;
            added++;
        }
    }
    if (added) intlHashToKeyMap = null;
    return added;
}
let localeMessagesCache: Record<string, unknown[]> | null = null;
let localeMessagesCacheTime = 0;

export function getLocaleMessages(): Record<string, unknown[]> | null {
    const now = Date.now();
    if (localeMessagesCache && now - localeMessagesCacheTime < CACHE_TTL.LOCALE_MESSAGES_MS) return localeMessagesCache;

    for (const mod of Object.values(wreq.c) as WebpackModule[]) {
        const exp = mod?.exports?.default;
        if (!exp || typeof exp !== "object") continue;
        const keys = Object.keys(exp).filter(k => k !== "__esModule");
        if (keys.length > INTL_DETECTION.MIN_LOCALE_KEY_COUNT && keys.every(k => k.length === 6 || k.length === 7)) {
            localeMessagesCache = exp as Record<string, unknown[]>;
            localeMessagesCacheTime = now;
            return localeMessagesCache;
        }
    }
    return null;
}

let orderedIntlHashesCache: string[] | null = null;

export function getOrderedIntlHashes(): string[] | null {
    if (orderedIntlHashesCache) return orderedIntlHashesCache;

    for (const [id, factory] of Object.entries(wreq.m) as [string, { toString(): string }][]) {
        const src = factory.toString();
        if (src.length < INTL_DETECTION.ORDERED_MODULE_MIN_SRC_LEN || !src.includes(INTL_DETECTION.ORDERED_MODULE_SENTINEL_HASH)) continue;

        const pattern = /"([A-Za-z0-9+/]{6})":/g;
        const hashes: string[] = [];
        const seen = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(src))) {
            if (!seen.has(m[1])) {
                seen.add(m[1]);
                hashes.push(m[1]);
            }
        }
        if (hashes.length > INTL_DETECTION.MIN_LOCALE_KEY_COUNT) {
            orderedIntlHashesCache = hashes;
            return hashes;
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

    const keyPattern = createIntlKeyPatternRegex(true);
    const extract = (str: string) => {
        let m: RegExpExecArray | null;
        while ((m = keyPattern.exec(str))) {
            intlHashToKeyMap!.set(runtimeHashMessageKey(m[1]), m[1]);
        }
    };

    for (const id of getModuleIds()) extract(getModuleSource(id));

    for (const plugin of Object.values(plugins)) {
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
    let depth = 0;

    const sanitize = (val: unknown): unknown => {
        if (val == null) return null;
        switch (typeof val) {
            case "bigint":
                return `${val}n`;
            case "symbol":
                return val.toString();
            case "function": {
                const str = val.toString();
                return str.length > 500 ? str.slice(0, 500) + "..." : str;
            }
            case "object": {
                if (seen.has(val)) return "[Circular]";
                seen.add(val);
                if (depth > 10) return "[Max Depth]";
                depth++;
                try {
                    if (val instanceof RegExp) return val.toString();
                    if (val instanceof Error) return { error: val.message, stack: val.stack?.slice(0, 500) };
                    if (val instanceof Map) return sanitize(Object.fromEntries(val));
                    if (val instanceof Set) return sanitize([...val].slice(0, 50));
                    if (Array.isArray(val)) return val.slice(0, 100).map(sanitize);
                    const obj: Record<string, unknown> = {};
                    const keys = Object.keys(val).filter(k => (val as Record<string, unknown>)[k] !== undefined);
                    for (const k of keys.slice(0, 50)) obj[k] = sanitize((val as Record<string, unknown>)[k]);
                    return obj;
                } finally {
                    depth--;
                }
            }
            case "string":
                return val.length > 1000 ? val.slice(0, 1000) + "..." : val;
            default:
                return val;
        }
    };

    try {
        const json = JSON.stringify(sanitize(value));
        return json.length > maxLength ? json.slice(0, maxLength) + "\n... [truncated]" : json;
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
    return [...(getFactoryPatchedBy(id) ?? [])];
}

export function getAllStoreNames(): string[] {
    return Flux.Store.getAll()
        .map(s => s.getName())
        .filter(nm => nm.length > 2 && /^[A-Z]/.test(nm))
        .sort();
}

export function getAdaptiveTimeout(toolName: string, args?: Record<string, unknown>): number {
    return getToolTimeout(toolName, args?.action as string | undefined);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${toolName} timed out after ${Math.round(ms / 1000)}s. The operation took too long to complete.`)), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

export function parseRegex(pattern: string): RegExp | null {
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const lastSlash = pattern.lastIndexOf("/");
        try {
            return getCachedRegex(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
        } catch {
            throw new Error(`Invalid regex: ${pattern}`);
        }
    }
    return null;
}

export function cleanupIntercept(id: number): boolean {
    const intercept = interceptState.active.get(id);
    if (!intercept) return false;

    if (intercept.methodKey && intercept.methodParent) {
        try {
            intercept.methodParent[intercept.methodKey] = intercept.original;
        } catch {
            /* ew */
        }
    } else {
        const mod = wreq.c[intercept.moduleId] as WebpackModule | undefined;
        if (mod) {
            try {
                if (intercept.exportKey === "module") {
                    Object.defineProperty(mod, "exports", { value: intercept.original, configurable: true, writable: true });
                } else if (mod.exports) {
                    Object.defineProperty(mod.exports, intercept.exportKey, { value: intercept.original, configurable: true, writable: true });
                }
            } catch {
                /* ew */
            }
        }
    }
    interceptState.active.delete(id);
    return true;
}

function expireAll<T extends { expiresAt: number }>(map: Map<number, T>, cleanup: (id: number) => void): void {
    const now = Date.now();
    for (const [id, v] of map) if (now >= v.expiresAt) cleanup(id);
}
function cleanAll<T>(map: Map<number, T>, cleanup: (id: number) => void): void {
    for (const id of [...map.keys()]) cleanup(id);
}

export const cleanupExpiredIntercepts = () => expireAll(interceptState.active, cleanupIntercept);
export const cleanupAllIntercepts = () => cleanAll(interceptState.active, cleanupIntercept);

export function cleanupTrace(id: number): boolean {
    const trace = traceState.active.get(id);
    if (!trace) return false;

    trace.unsub?.();
    traceState.active.delete(id);

    if (!traceState.active.size && traceState.interceptor) {
        const { _interceptors } = getFluxDispatcherInternal();
        const { interceptor } = traceState;
        if (_interceptors) removeFromArray(_interceptors, i => i === interceptor);
        traceState.interceptor = null;
    }
    return true;
}

export const cleanupExpiredTraces = () => expireAll(traceState.active, cleanupTrace);
export const cleanupAllTraces = () => cleanAll(traceState.active, cleanupTrace);

export function cleanupModuleWatch(id: number): boolean {
    const watch = moduleWatchState.active.get(id);
    if (!watch) return false;
    if (watch.listener) factoryListeners.delete(watch.listener);
    moduleWatchState.active.delete(id);
    return true;
}

export const cleanupExpiredModuleWatches = () => expireAll(moduleWatchState.active, cleanupModuleWatch);
export const cleanupAllModuleWatches = () => cleanAll(moduleWatchState.active, cleanupModuleWatch);

const FIBER_TAGS: Readonly<Record<number, string>> = {
    0: "Function",
    1: "Class",
    2: "Indeterminate",
    3: "HostRoot",
    4: "Portal",
    5: "DOM",
    6: "Text",
    7: "Fragment",
    8: "Mode",
    9: "ContextConsumer",
    10: "ContextProvider",
    11: "ForwardRef",
    12: "Profiler",
    13: "Suspense",
    14: "Memo",
    15: "SimpleMemo",
    16: "Lazy",
    17: "IncompleteClass",
    18: "DehydratedFragment",
    19: "SuspenseList",
    20: "Scope",
    21: "Offscreen",
    22: "LegacyHidden",
    23: "Cache",
    24: "TracingMarker",
    25: "HostHoistable",
    26: "HostSingleton",
    27: "HostResource",
};

export function getFiber(el: Element): ReactFiber | null {
    for (const key in el) {
        if (key.startsWith("__reactFiber$")) return (el as any)[key] as ReactFiber;
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

let cssCache: CSSIndexCache | null = null;

export function isRenderedClassName(input: string): boolean {
    return CSS_CLASS_RE.test(input);
}

function isCSSModule(exports: unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const keys = Object.keys(exports);
    return (
        keys.length >= 3 &&
        keys.every(k => {
            const v = (exports as Record<string, unknown>)[k];
            return typeof v === "string" && CSS_CLASS_RE.test(v);
        })
    );
}

function buildCSSIndex(): CSSIndexCache {
    const index = new Map<string, CSSClassEntry>();
    const modules = new Map<string, CSSModuleInfo>();

    for (const [id, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
        if (!mod?.exports || !isCSSModule(mod.exports)) continue;
        const exp = mod.exports as Record<string, string>;
        const keys = Object.keys(exp);
        const firstVal = exp[keys[0]];
        const hashIdx = firstVal.lastIndexOf("_");
        const hash = hashIdx !== -1 ? firstVal.slice(hashIdx + 1) : "";
        const classes: Record<string, string> = {};

        for (const k of keys) {
            const v = exp[k];
            classes[k] = v;
            const semIdx = v.lastIndexOf("_");
            const semantic = semIdx !== -1 ? v.slice(0, semIdx) : v;
            index.set(v, { moduleId: id, key: k, semantic, hash });
        }

        modules.set(id, { classCount: keys.length, hash, classes });
    }

    return { index, modules, builtAt: Date.now() };
}

export function getCSSIndex(): CSSIndexCache {
    if (cssCache && Date.now() - cssCache.builtAt < CACHE_TTL.CSS_INDEX_MS) return cssCache;
    cssCache = buildCSSIndex();
    return cssCache;
}

export function clearCSSIndexCache(): void {
    cssCache = null;
}

export function getCSSModuleStats() {
    const { modules } = getCSSIndex();
    let totalClasses = 0;
    const sorted: Array<{ moduleId: string; classCount: number; hash: string; sampleClasses: string[] }> = [];

    for (const [id, info] of modules) {
        totalClasses += info.classCount;
        sorted.push({
            moduleId: id,
            classCount: info.classCount,
            hash: info.hash,
            sampleClasses: Object.values(info.classes).slice(0, LIMITS.CSS.SAMPLE_CLASSES),
        });
    }

    sorted.sort((a, b) => b.classCount - a.classCount);

    return {
        totalModules: modules.size,
        totalClasses,
        topModules: sorted.slice(0, LIMITS.CSS.TOP_MODULES),
    };
}

let componentCache: ComponentIndex | null = null;

function buildComponentIndex(): ComponentIndex {
    const stories: StoryEntry[] = [];
    const manaTypes = new Map<string, string[]>();
    const displayNames = new Map<string, Array<{ moduleId: string; key: string }>>();

    const addToMap = <V>(map: Map<string, V[]>, key: string, val: V) => {
        const arr = map.get(key);
        if (arr) arr.push(val);
        else map.set(key, [val]);
    };

    const getDisplayName = (val: unknown): string | undefined => {
        if (typeof val === "function") return (val as any).displayName;
        if (val && typeof val === "object") {
            const obj = val as Record<string, unknown>;
            return (obj.displayName ?? (obj.render as { displayName?: string } | undefined)?.displayName) as string | undefined;
        }
        return undefined;
    };

    for (const [id, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
        if (!mod?.exports) continue;
        const exp = mod.exports;

        const scanExport = (val: unknown, key: string) => {
            const dn = getDisplayName(val);
            if (dn) addToMap(displayNames, dn, { moduleId: id, key });

            if (val && typeof val === "object") {
                const obj = val as Record<string, unknown>;
                if (Array.isArray(obj.stories) && obj.title) {
                    for (const story of obj.stories as Array<Record<string, unknown>>) {
                        const controls: Record<string, StoryControl> = {};
                        if (story.controls && typeof story.controls === "object") {
                            for (const [ck, cv] of Object.entries(story.controls as Record<string, Record<string, unknown>>)) {
                                controls[ck] = {
                                    type: cv.type as string,
                                    label: cv.label as string | undefined,
                                    defaultValue: cv.defaultValue,
                                    options: Array.isArray(cv.options)
                                        ? cv.options.slice(0, LIMITS.COMPONENT.MAX_OPTIONS).map(o => (o && typeof o === "object" && "value" in (o as object) ? (o as { value: unknown }).value : o))
                                        : undefined,
                                };
                            }
                        }
                        stories.push({ moduleId: id, title: obj.title as string, name: story.name as string, id: story.id as string, docs: story.docs as string | undefined, controls });
                    }
                }
            }
        };

        scanExport(exp, "module");
        if (typeof exp === "object") {
            for (const [k, v] of Object.entries(exp)) scanExport(v, k);
        }
    }

    for (const id of Object.keys(wreq.m)) {
        const factory = wreq.m[id];
        if (!factory) continue;
        const src = Function.prototype.toString.call(factory);
        for (const m of src.matchAll(MANA_COMPONENT_RE)) {
            addToMap(manaTypes, m[1], id);
        }
    }

    let components = 0,
        enums = 0;
    const uiBarrelId = getUIBarrelModuleId();
    if (UIBarrelModule) {
        for (const val of Object.values(UIBarrelModule)) {
            if (typeof val === "function") components++;
            else if (val && typeof val === "object") {
                const obj = val as Record<string, unknown>;
                if (obj.$$typeof) components++;
                else {
                    const vals = Object.values(obj);
                    if (vals.length > 0 && vals.length < 30 && vals.every(v => typeof v === "string" || typeof v === "number")) enums++;
                }
            }
        }
    }

    const iconCount = IconsModule ? Object.keys(IconsModule).filter(k => typeof IconsModule[k] === "function" && k.endsWith("Icon")).length : 0;
    const iconsModuleId = getIconsModuleId();

    return { stories, manaTypes, displayNames, uiBarrelId, iconsModuleId, uiBarrelStats: { components, icons: iconCount, enums }, builtAt: Date.now() };
}

export function getComponentIndex(): ComponentIndex {
    if (componentCache && Date.now() - componentCache.builtAt < CACHE_TTL.COMPONENT_INDEX_MS) return componentCache;
    componentCache = buildComponentIndex();
    return componentCache;
}

export function clearComponentIndexCache(): void {
    componentCache = null;
}

export function extractPropsFromFunction(fn: Function): Array<{ name: string; default?: string }> {
    const src = fn.toString().slice(0, LIMITS.COMPONENT.PROP_SRC_SLICE);
    const match = src.match(/let\{([^}]+)\}=e/);
    if (!match) return [];

    const props: Array<{ name: string; default?: string }> = [];
    for (const p of match[1].split(",")) {
        if (props.length >= LIMITS.COMPONENT.MAX_PROPS) break;
        const parts = p.trim().split(":");
        const name = parts[0].replace(/^["']|["']$/g, "").trim();
        if (!name || name.startsWith("...")) continue;
        const rest = parts.slice(1).join(":").trim();
        const defMatch = rest.match(/=(.+)/);
        props.push({ name, default: defMatch ? defMatch[1].trim() : undefined });
    }
    return props;
}

export function scanSingleOccurrences(source: string, regex: RegExp, extract: (m: RegExpExecArray) => { find: string; search: string; type: string } | null, max = 10): AnchorCandidate[] {
    const counts = new Map<string, number>();
    const positions = new Map<string, number>();
    const entries = new Map<string, { find: string; search: string; type: string }>();
    let m: RegExpExecArray | null;

    while ((m = regex.exec(source))) {
        const entry = extract(m);
        if (!entry) continue;
        const key = entry.find;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!positions.has(key)) {
            positions.set(key, m.index);
            entries.set(key, entry);
        }
    }

    const results: AnchorCandidate[] = [];
    for (const [key, count] of counts) {
        if (count !== 1 || results.length >= max) continue;
        const entry = entries.get(key)!;
        results.push({ ...entry, index: positions.get(key)! });
    }
    return results;
}

export function collectMethods(obj: unknown, limit = 20): string[] {
    if (!obj || typeof obj !== "object") return [];
    const methods = new Set<string>();
    for (const k of Object.keys(obj)) {
        if (typeof (obj as Record<string, unknown>)[k] === "function") methods.add(k);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
            if (k !== "constructor" && typeof (obj as Record<string, unknown>)[k] === "function") methods.add(k);
        }
    }
    return [...methods].slice(0, limit);
}

export function compareByAnchorType(a: { type: string; unique?: boolean }, b: { type: string; unique?: boolean }, typeOrder: Readonly<Record<string, number>>): number {
    if (a.unique !== b.unique) return a.unique ? -1 : 1;
    const aBase = a.type.replace("+ctx", "");
    const bBase = b.type.replace("+ctx", "");
    return (typeOrder[aBase] ?? 9) - (typeOrder[bBase] ?? 9);
}

interface HintExport {
    displayName?: string;
    name?: string;
    $$typeof?: symbol;
    render?: { displayName?: string };
    type?: { displayName?: string; name?: string };
    default?: { displayName?: string; name?: string };
    getName?: () => string;
    emitChange?: () => void;
}

export function getModuleHint(id: string): string | null {
    const mod = wreq.c[id] as WebpackModule | undefined;
    if (!mod?.exports) return null;
    const exp = mod.exports as Record<string, HintExport | string | undefined> & HintExport;
    const dn = exp.default?.displayName ?? exp.displayName ?? exp.default?.name;
    if (typeof dn === "string" && dn.length > 1) return dn;
    const keys = Object.keys(exp);
    if (keys.length <= 3 && keys.every(k => CSS_CLASS_RE.test(typeof exp[k] === "string" ? (exp[k] as string) : ""))) return "[css]";
    for (const k of keys) {
        const val = exp[k];
        if (!val || typeof val !== "object") continue;
        const proto = safeProto(val) as HintExport | null;
        if (proto?.getName && proto.emitChange) {
            const storeName = safeCall(() => (val as HintExport).getName?.(), undefined);
            if (storeName) return storeName + " (store)";
        }
    }
    for (const k of keys) {
        const val = exp[k];
        if (!val || typeof val !== "object" || !val.$$typeof) continue;
        const name = val.displayName ?? val.render?.displayName ?? val.type?.displayName ?? val.type?.name;
        if (typeof name === "string" && name.length > 1) return name + " (component)";
        const st = String(val.$$typeof);
        if (st.includes("memo")) return "[memo component]";
        if (st.includes("forward_ref")) return "[forwardRef component]";
        return "[component]";
    }
    const meaningful = keys.filter(k => k.length > 2 && !/^[A-Z]{1,2}$/.test(k));
    if (meaningful.length) {
        if (meaningful.length <= 5) return meaningful.join(",");
        return meaningful.slice(0, 3).join(",") + `...+${meaningful.length - 3}`;
    }
    if (keys.length === 1) {
        const val = exp[keys[0]];
        if (val && typeof val === "object") {
            const valKeys = Object.keys(val).filter(k => k.length > 2);
            if (valKeys.length) return valKeys.slice(0, 3).join(",") + (valKeys.length > 3 ? `...+${valKeys.length - 3}` : "");
        }
    }
    if (keys.length <= 5) return keys.join(",");
    return `${keys.length} exports`;
}

export function patchFindAsString(find: string | RegExp | undefined): string {
    if (typeof find === "string") return find;
    return find?.toString() ?? "";
}

export interface CanonFindMatcher {
    test: (src: string) => boolean;
    canonical: string;
    isRegex: boolean;
}

export function canonFindMatcher(find: string | RegExp | undefined): CanonFindMatcher {
    if (!find) return { test: () => false, canonical: "", isRegex: false };
    if (find instanceof RegExp) {
        const r = canonicalizeMatch(find);
        return {
            test: (src: string) => { if (r.global) r.lastIndex = 0; return r.test(src); },
            canonical: r.source,
            isRegex: true,
        };
    }
    const s = canonicalizeMatch(find);
    return { test: (src: string) => src.includes(s), canonical: s, isRegex: false };
}

export function getReplacements(patch: PluginPatch): PluginReplacement[] {
    return Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string { return s.replace(REGEX_META, "\\$&"); }

export function buildPatchRegex(match: string | RegExp): RegExp {
    if (match instanceof RegExp) return canonicalizeMatch(match);
    const parsed = parseRegex(match);
    if (parsed) return canonicalizeMatch(parsed);
    return getCachedRegex(escapeRegex(canonicalizeMatch(match)));
}

export interface BenchmarkResult {
    coldMs: number;
    medianUs: number;
    minUs: number;
    roundsUs: number[];
    wouldFlagSlow: boolean;
}

export function benchmarkReplace(source: string, regex: RegExp, replaceStr: string, iters: number, numRounds: number): BenchmarkResult {
    const coldStart = performance.now();
    source.replace(regex, replaceStr);
    const coldMs = performance.now() - coldStart;

    const warmup = Math.min(iters, 500);
    for (let i = 0; i < warmup; i++) source.replace(regex, replaceStr);

    const roundTimes: number[] = [];
    for (let r = 0; r < numRounds; r++) {
        const start = performance.now();
        for (let i = 0; i < iters; i++) source.replace(regex, replaceStr);
        roundTimes.push(performance.now() - start);
    }

    const perOp = roundTimes.map(t => t / iters);
    const sorted = [...perOp].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
        coldMs: +coldMs.toFixed(3),
        medianUs: +(median * 1000).toFixed(2),
        minUs: +(Math.min(...perOp) * 1000).toFixed(2),
        roundsUs: perOp.map(t => +(t * 1000).toFixed(2)),
        wouldFlagSlow: coldMs > 5,
    };
}

export function clamp(v: number | undefined, def: number, lo: number, hi: number): number {
    return Math.min(Math.max(v ?? def, lo), hi);
}
export const clampIters = (v: number | undefined, def: number, lo = 100, hi = 100_000) => clamp(v, def, lo, hi);
export const clampRounds = (v: number | undefined, def: number, lo = 1, hi = 10) => clamp(v, def, lo, hi);

export function countUnescapedCaptures(pattern: string): number {
    let count = 0;
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") { i++; continue; }
        if (c === "[") { inClass = true; continue; }
        if (c === "]") { inClass = false; continue; }
        if (inClass) continue;
        if (c !== "(") continue;
        if (pattern[i + 1] !== "?") { count++; continue; }
        if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") count++;
    }
    return count;
}

export function extractCaptureNames(pattern: string): string[] {
    const names: string[] = [];
    const re = /\(\?<([A-Za-z_$][\w$]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pattern))) names.push(m[1]);
    return names;
}

export interface IntlProbe {
    intlKey: string;
    intlStatus: "key_valid_but_unused" | "key_not_found";
}

let _intlKeyPatternSingle: RegExp | null = null;
function _intlKeyPattern(): RegExp {
    return (_intlKeyPatternSingle ??= /#\{intl::([A-Z][A-Z0-9_]*)/);
}

export function probeIntlKey(rawFind: string): IntlProbe | null {
    const m = rawFind.match(_intlKeyPattern());
    if (!m?.[1]) return null;
    const hash = runtimeHashMessageKey(m[1]);
    return { intlKey: m[1], intlStatus: intlHashExistsInDefinitions(hash) ? "key_valid_but_unused" : "key_not_found" };
}

export function snippetAround(source: string, idx: number, matchLen: number, before = 60, after = 120): string {
    return source.slice(Math.max(0, idx - before), Math.min(source.length, idx + matchLen + after));
}

export interface PluginPatchIteration {
    name: string;
    plugin: VencordPluginLike;
    patch: PluginPatch;
    patchIndex: number;
    rawFind: string;
    canonFind: string;
}
type VencordPluginLike = { started?: boolean; required?: boolean; patches?: PluginPatch[] };

export function* iterPluginPatches(pluginsMap: Record<string, VencordPluginLike>, filter?: string): Generator<PluginPatchIteration> {
    const lowerFilter = filter?.toLowerCase();
    for (const [name, plugin] of Object.entries(pluginsMap)) {
        if (lowerFilter && !name.toLowerCase().includes(lowerFilter)) continue;
        if (!plugin.patches?.length) continue;
        for (let patchIndex = 0; patchIndex < plugin.patches.length; patchIndex++) {
            const patch = plugin.patches[patchIndex];
            const rawFind = patchFindAsString(patch.find);
            yield { name, plugin, patch, patchIndex, rawFind, canonFind: canonicalizeMatch(rawFind) };
        }
    }
}

export function forEachLoadedModule(cb: (id: string, exports: WebpackModule["exports"]) => boolean | void): void {
    for (const [id, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
        if (!mod?.exports) continue;
        if (cb(id, mod.exports) === false) return;
    }
}

export const safeCall = tryOrElse;
export { isNonNullish, isObject };

export function safeProto(obj: object | null | undefined): object | null {
    if (!obj) return null;
    try { return Object.getPrototypeOf(obj); } catch { return null; }
}

export function filterByLowerIncludes<T>(items: readonly T[], query: string, key: (t: T) => string): T[] {
    const lower = query.toLowerCase();
    return items.filter(item => key(item).toLowerCase().includes(lower));
}

export function rankedSuggestions(names: readonly string[], query: string, max: number): string[] {
    const lower = query.toLowerCase();
    const starts: string[] = [];
    const contains: string[] = [];
    for (const name of names) {
        const nl = name.toLowerCase();
        if (nl.startsWith(lower)) starts.push(name);
        else if (nl.includes(lower)) contains.push(name);
    }
    return [...starts, ...contains].slice(0, max);
}

export function isClassComponent(v: unknown): boolean {
    return typeof v === "function" && !!(v as { prototype?: { render?: unknown } }).prototype?.render;
}

export function missingArg(name: string): { error: true; message: string } {
    return { error: true, message: `${name} required` };
}

export function getDescriptor(obj: object, proto: object | null, name: string): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(obj, name) ?? (proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined);
}

export function compileFilterRegex(pattern: string, flags = "i"): RegExp | null {
    try { return new RegExp(pattern, flags); } catch { return null; }
}

export { findAll, findStore, getIntlMessageFromHash, KEY_MAP, runtimeHashMessageKey };
