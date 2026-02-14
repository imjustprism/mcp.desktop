/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getIntlMessageFromHash } from "@utils/discord";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { WebpackPatcher } from "Vencord";

import keyMapJson from "../map/key_map.json";
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
import { createIntlKeyPatternRegex, CSS_CLASS_RE, LIMITS, MANA_COMPONENT_RE, REGEX_CACHE_MAX_SIZE } from "./constants";

const KEY_MAP: Record<string, string> = keyMapJson;
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
            case "bigint": return `${val}n`;
            case "symbol": return val.toString();
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
                } finally { depth--; }
            }
            case "string": return val.length > 1000 ? val.slice(0, 1000) + "..." : val;
            default: return val;
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
    return [...getFactoryPatchedBy(id) ?? []];
}

export function getAllStoreNames(): string[] {
    return Flux.Store.getAll()
        .map(s => s.getName())
        .filter(nm => nm.length > 2 && /^[A-Z]/.test(nm))
        .sort();
}

export function getAdaptiveTimeout(toolName: string, args?: Record<string, unknown>): number {
    if (toolName === "module" && args?.action === "loadLazy") return 120000;
    if (toolName === "intl" && args?.action === "bruteforce") return 300000;
    if (toolName === "trace" || toolName === "intercept") return 120000;
    if (toolName === "module" || toolName === "intl") return 60000;
    return 5000;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`"${toolName}" timed out (${ms}ms)`)), ms);
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
        } catch { /* property not writable */ }
    } else {
        const mod = wreq.c[intercept.moduleId] as WebpackModule | undefined;
        if (mod) {
            try {
                if (intercept.exportKey === "module") {
                    Object.defineProperty(mod, "exports", { value: intercept.original, configurable: true, writable: true });
                } else if (mod.exports) {
                    Object.defineProperty(mod.exports, intercept.exportKey, { value: intercept.original, configurable: true, writable: true });
                }
            } catch { /* property not configurable */ }
        }
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
        const dispatcher = getFluxDispatcherInternal();
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

let cssCache: CSSIndexCache | null = null;

export function isRenderedClassName(input: string): boolean {
    return CSS_CLASS_RE.test(input);
}

function isCSSModule(exports: unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const keys = Object.keys(exports);
    return keys.length >= 3 && keys.every(k => {
        const v = (exports as Record<string, unknown>)[k];
        return typeof v === "string" && CSS_CLASS_RE.test(v);
    });
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
    if (cssCache && Date.now() - cssCache.builtAt < LIMITS.CSS.INDEX_TTL_MS) return cssCache;
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
        if (typeof val === "function") return (val as unknown as { displayName?: string }).displayName;
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
                                        ? cv.options.slice(0, LIMITS.COMPONENT.MAX_OPTIONS).map(o =>
                                            o && typeof o === "object" && "value" in (o as object) ? (o as { value: unknown }).value : o)
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

    let components = 0, enums = 0;
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
    if (componentCache && Date.now() - componentCache.builtAt < LIMITS.COMPONENT.INDEX_TTL_MS) return componentCache;
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

export { findAll, findStore, getIntlMessageFromHash, KEY_MAP, runtimeHashMessageKey };
