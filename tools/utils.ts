import { getIntlMessageFromHash } from "@utils/discord";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { Logger } from "@utils/Logger";
import { isObject, removeFromArray, tryOrElse } from "@utils/misc";
import { canonicalizeMatch } from "@utils/patches";
import { escapeRegExp } from "@utils/text";
import * as WebpackPatcher from "@webpack/patcher";

import { recoverIntlKey } from "../finds/intlRecover";
import { mergeValidated, serializeKeyMap, validatePersistedEntries } from "../finds/keyMapPersist";
import keyMapJson from "../map/key_map.json";
import {
    ActiveTrace,
    AnchorCandidate,
    BatchResult,
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
    ToolError,
    WebpackModule,
} from "../types";
import { factoryListeners, findStore, Flux, getFluxDispatcherInternal, i18n, plugins, wreq } from "../webpack";
import { CACHE_TTL, createIntlHashBracketRegex, createIntlHashDotRegex, createIntlKeyPatternRegex, CSS_CLASS_RE, HOOK_EFFECT_FLAGS, INTL_DETECTION, LIMITS, REGEX_CACHE_MAX_SIZE, SANITIZE } from "./constants";

export const mcpLogger = new Logger("mcp", "#d97756");

const { getFactoryPatchedSource, getFactoryPatchedBy } = WebpackPatcher;

const regexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string, flags = ""): RegExp {
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

export const moduleAt = (id: PropertyKey): WebpackModule | undefined => wreq.c[id] as WebpackModule | undefined;
export const moduleEntries = (): [string, WebpackModule][] => Object.entries(wreq.c) as [string, WebpackModule][];

export function classifyExportType(val: unknown): string {
    if (typeof val !== "function") return typeof val;
    return (val as { prototype?: { render?: unknown } }).prototype?.render ? "Component" : "Function";
}

export function* eachPatch(): Generator<{ name: string; patch: PluginPatch; index: number }> {
    for (const [name, plugin] of Object.entries(plugins)) {
        if (!plugin.patches?.length) continue;
        let index = 0;
        for (const patch of plugin.patches) yield { name, patch, index: index++ };
    }
}

const batchResultsCache = new Map<string, BatchResult>();
let batchCacheTime = 0;

export function clearBatchResultsCache(): void {
    batchResultsCache.clear();
}

const moduleSourceCache = new Map<string, string>();
let moduleSourceCacheTime = 0;

export function getModuleSource(id: string): string {
    const now = Date.now();
    if (now - moduleSourceCacheTime > CACHE_TTL.MODULE_SOURCE_MS) {
        moduleSourceCache.clear();
        moduleSourceCacheTime = now;
    }

    let source = moduleSourceCache.get(id);
    if (!source) {
        const factory = wreq.m[id];
        if (!factory) return "";
        const code = String(factory);
        source = "0," + (code.startsWith("(") ? "" : "function") + code.slice(code.indexOf("("));
        moduleSourceCache.set(id, source);
    }
    return source;
}

export function clearModuleSourceCache(): void {
    moduleSourceCache.clear();
}

const MODULE_HEADER_RE = /^0,(?:function)?\(\w+,\w+,(\w+)\)/;
const requireParam = (src: string) => MODULE_HEADER_RE.exec(src.slice(0, 40))?.[1];
let depGraphCache: { forward: Map<string, string[]>; reverse: Map<string, string[]> } | null = null;
let depGraphCount = -1;

export function buildDependencyGraph(): { forward: Map<string, string[]>; reverse: Map<string, string[]> } {
    const ids = getModuleIds();
    if (depGraphCache && ids.length === depGraphCount) return depGraphCache;
    const forward = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const id of ids) {
        const src = getModuleSource(id);
        const p = requireParam(src);
        if (!p) continue;
        const callRe = getCachedRegex("(?<![\\w$.])" + p + "(?:\\.n)?\\((\\d+)\\)", "g");
        const bindRe = getCachedRegex(p + "\\.bind\\(" + p + ",(\\d+)\\)", "g");
        const deps = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(src))) if (m[1] !== id) deps.add(m[1]);
        while ((m = bindRe.exec(src))) if (m[1] !== id) deps.add(m[1]);
        if (!deps.size) continue;
        const arr = [...deps];
        forward.set(id, arr);
        for (const d of arr) reverse.get(d)?.push(id) ?? reverse.set(d, [id]);
    }
    depGraphCache = { forward, reverse };
    depGraphCount = ids.length;
    return depGraphCache;
}

export function clearDependencyGraphCache(): void {
    depGraphCache = null;
    depGraphCount = -1;
}

let identityIndex: WeakMap<object, { id: string; key: string }> | null = null;
let identityIndexCount = -1;

export const innerType = (val: { type?: unknown; render?: unknown }): unknown => val.type ?? val.render;

function buildExportIdentityIndex(): WeakMap<object, { id: string; key: string }> {
    const loaded = Object.keys(wreq.c);
    if (identityIndex && loaded.length === identityIndexCount) return identityIndex;
    const index = new WeakMap<object, { id: string; key: string }>();
    for (const id of loaded) {
        const exports = wreq.c[id]?.exports;
        if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
        index.set(exports as object, { id, key: "module" });
        let keys: string[];
        try { keys = Object.keys(exports); } catch { continue; }
        for (const key of keys) {
            let val: unknown;
            try { val = (exports as Record<string, unknown>)[key]; } catch { continue; }
            if (!val || (typeof val !== "object" && typeof val !== "function")) continue;
            if (!index.has(val as object)) index.set(val as object, { id, key });
            let inner: unknown;
            try { inner = innerType(val as { type?: unknown; render?: unknown }); } catch { continue; }
            if (inner && (typeof inner === "object" || typeof inner === "function") && !index.has(inner as object)) index.set(inner as object, { id, key });
        }
    }
    identityIndex = index;
    identityIndexCount = loaded.length;
    return index;
}

export function invalidateIdentityIndex(): void {
    identityIndex = null;
    identityIndexCount = -1;
}

export function lookupIdentity(value: unknown): { id: string; key: string } | null {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    return buildExportIdentityIndex().get(value as object) ?? null;
}

export function parsePublicExports(id: string): Record<string, string> {
    const src = getModuleSource(id);
    const p = requireParam(src);
    if (!p) return {};
    const publicExports: Record<string, string> = {};
    const dRe = new RegExp("(?<![\\w$.])" + p + "\\.d\\(\\w+,\\{", "g");
    let dm: RegExpExecArray | null;
    while ((dm = dRe.exec(src))) {
        const braceStart = src.indexOf("{", dm.index);
        let depth = 0;
        let end = -1;
        for (let i = braceStart; i < src.length; i++) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}" && --depth === 0) { end = i; break; }
        }
        if (end < 0) continue;
        for (const mm of src.slice(braceStart + 1, end).matchAll(/(\w+):\(\)=>\(?(?:0,)?([\w$]+(?:\.[\w$]+)*)\)?/g)) if (!Object.hasOwn(publicExports, mm[1])) publicExports[mm[1]] = mm[2];
    }
    return publicExports;
}

export function countModuleMatches(str: string, earlyExit = 10): number {
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
const intlRecoverFailed = new Set<string>();
const runtimeLearnedKeys = new Map<string, string>();
let keyMapWriter: ((json: string) => void) | null = null;
let keyMapPersistTimer: ReturnType<typeof setTimeout> | null = null;
const KEYMAP_PERSIST_DEBOUNCE_MS = 2000;

export function clearIntlCache(): void {
    intlHashToKeyMap = null;
    intlRecoverFailed.clear();
}

export function learnedKeyCount(): number {
    return runtimeLearnedKeys.size;
}

function scheduleKeyMapPersist(): void {
    if (!keyMapWriter || !runtimeLearnedKeys.size) return;
    if (keyMapPersistTimer) clearTimeout(keyMapPersistTimer);
    keyMapPersistTimer = setTimeout(() => {
        keyMapPersistTimer = null;
        keyMapWriter?.(serializeKeyMap(runtimeLearnedKeys));
    }, KEYMAP_PERSIST_DEBOUNCE_MS);
}

export async function initKeyMapPersistence(io: { read: () => Promise<string | null>; write: (json: string) => void }): Promise<number> {
    keyMapWriter = io.write;
    const text = await io.read();
    if (!text) return 0;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return 0; }
    const validated = validatePersistedEntries(raw, runtimeHashMessageKey);
    mergeValidated(runtimeLearnedKeys, validated);
    return intlHashToKeyMap ? mergeValidated(intlHashToKeyMap, validated) : validated.size;
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

export function extractIntlText(arr: unknown): string {
    if (!Array.isArray(arr)) return String(arr ?? "");
    return arr.filter(item => typeof item === "string").join("");
}

function intlHashExistsInDefinitions(hash: string): boolean {
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
    const map = (intlHashToKeyMap = new Map<string, string>(Object.entries(keyMapJson)));

    const keyPattern = createIntlKeyPatternRegex();
    const extract = (str: string) => {
        let m: RegExpExecArray | null;
        while ((m = keyPattern.exec(str))) {
            map.set(runtimeHashMessageKey(m[1]), m[1]);
        }
    };

    for (const id of getModuleIds()) extract(getModuleSource(id));

    for (const { patch } of eachPatch()) {
        if (typeof patch.find === "string") extract(patch.find);
        else if (patch.find instanceof RegExp) extract(patch.find.source);
        for (const r of getReplacements(patch)) {
            if (r?.match instanceof RegExp) extract(r.match.source);
            else if (typeof r?.match === "string") extract(r.match);
            if (typeof r?.replace === "string") extract(r.replace);
        }
    }

    mergeValidated(map, runtimeLearnedKeys);

    return map;
}

export function getIntlKeyFromHash(hash: string): string | null {
    return buildIntlHashToKeyMap().get(hash) ?? null;
}

export function recoverIntlKeys(recoverLimit: number, maxAttempts = 3000): { attempted: number; recovered: number; entries: Array<{ hash: string; key: string; message: string }> } {
    const map = buildIntlHashToKeyMap();
    const locale = getLocaleMessages();
    const entries: Array<{ hash: string; key: string; message: string }> = [];
    let attempted = 0;
    if (!locale) return { attempted, recovered: 0, entries };
    for (const hash in locale) {
        if (attempted >= maxAttempts || entries.length >= recoverLimit) break;
        if (map.has(hash) || intlRecoverFailed.has(hash)) continue;
        const message = extractIntlText(locale[hash]);
        if (!message) continue;
        attempted++;
        const key = recoverIntlKey(hash, message, runtimeHashMessageKey);
        if (key) {
            map.set(hash, key);
            runtimeLearnedKeys.set(hash, key);
            entries.push({ hash, key, message: message.slice(0, 80) });
        } else intlRecoverFailed.add(hash);
    }
    if (entries.length) scheduleKeyMapPersist();
    return { attempted, recovered: entries.length, entries };
}

export function findModuleIds(predicate: (source: string, id: string) => boolean, limit: number): string[] {
    const results: string[] = [];
    const ids = getModuleIds();
    for (let i = 0; i < ids.length && results.length < limit; i++) {
        const source = getModuleSource(ids[i]);
        if (source && predicate(source, ids[i])) results.push(ids[i]);
    }
    return results;
}

function sanitizeValue(value: unknown, strCap: number): unknown {
    const seen = new WeakSet();
    let depth = 0;

    const rec = (val: unknown): unknown => {
        if (val == null) return null;
        switch (typeof val) {
            case "bigint":
                return `${val}n`;
            case "symbol":
                return val.toString();
            case "function": {
                const str = val.toString();
                return str.length > SANITIZE.TOSTRING_MAX ? str.slice(0, SANITIZE.TOSTRING_MAX) + "..." : str;
            }
            case "object": {
                if (seen.has(val)) return "[Circular]";
                if (depth > SANITIZE.MAX_DEPTH) return "[Max Depth]";
                seen.add(val);
                depth++;
                try {
                    if (val instanceof RegExp) return val.toString();
                    if (val instanceof Error) return { error: val.message, stack: val.stack?.slice(0, SANITIZE.TOSTRING_MAX) };
                    if (val instanceof Map) return rec(Object.fromEntries(val));
                    if (val instanceof Set) return rec([...val].slice(0, SANITIZE.SET_MAX));
                    if (Array.isArray(val)) return val.slice(0, SANITIZE.ARRAY_MAX).map(rec);
                    const obj: Record<string, unknown> = {};
                    const o = val as Record<string, unknown>;
                    const keys = Object.keys(o).filter(k => o[k] !== undefined);
                    for (const k of keys.slice(0, SANITIZE.KEYS_MAX)) obj[k] = rec(o[k]);
                    return obj;
                } finally {
                    seen.delete(val);
                    depth--;
                }
            }
            case "string":
                return val.length > strCap ? val.slice(0, strCap) + "..." : val;
            case "number":
                return Number.isFinite(val) ? val : String(val);
            default:
                return val;
        }
    };

    return rec(value);
}

export function serializeResult(value: unknown, maxLength: number = SANITIZE.OUTPUT_MAX_LENGTH): string {
    try {
        const json = JSON.stringify(sanitizeValue(value, maxLength));
        return json.length > maxLength ? json.slice(0, maxLength) + "\n... [truncated]" : json;
    } catch {
        return String(value);
    }
}

export function toStructuredContent(value: unknown, maxLength: number = SANITIZE.OUTPUT_MAX_LENGTH): Record<string, unknown> | undefined {
    const s = sanitizeValue(value, maxLength);
    return s !== null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : undefined;
}

export function extractModule(id: PropertyKey, patched = true): string {
    if (patched) {
        const patchedSource = getFactoryPatchedSource(id);
        if (patchedSource) return patchedSource;
    }

    const source = getModuleSource(String(id));
    if (!source) throw new Error(`Module ${String(id)} not found`);
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

export function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${toolName} timed out after ${Math.round(ms / 1000)}s`)), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

export function parseRegex(pattern: string): RegExp | null {
    const lastSlash = pattern.lastIndexOf("/");
    if (pattern.startsWith("/") && lastSlash > 0) {
        try {
            return getCachedRegex(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
        } catch {
            throw new Error(`Invalid regex: ${pattern}`);
        }
    }
    return null;
}

interface SourceMatcher {
    test(src: string): boolean;
    firstIndex(src: string): number;
    matchLen(src: string): number;
}

export function makePatternMatcher(pattern: string): SourceMatcher {
    const parsed = parseRegex(pattern);
    const regex = parsed ? stripGlobal(canonicalizeMatch(parsed)) : null;

    if (regex) {
        return {
            test: src => regex.test(src),
            firstIndex: src => src.search(regex),
            matchLen: src => src.match(regex)?.[0].length ?? 0,
        };
    }

    const canon = canonicalizeMatch(pattern);
    return {
        test: src => src.includes(canon),
        firstIndex: src => src.indexOf(canon),
        matchLen: () => canon.length,
    };
}

export function snippet(source: string, idx: number, matchLen: number, before = 60, after = 120): string {
    if (idx < 0) return source.slice(0, 200);
    return source.slice(Math.max(0, idx - before), Math.min(source.length, idx + matchLen + after));
}

export function cleanupIntercept(id: number): boolean {
    const intercept = interceptState.active.get(id);
    if (!intercept) return false;
    invalidateIdentityIndex();

    const { methodKey, methodParent, exportKey, original } = intercept;
    try {
        if (methodKey && methodParent) {
            methodParent[methodKey] = original;
        } else {
            const mod = moduleAt(intercept.moduleId);
            const target = exportKey === "module" ? mod : mod?.exports;
            const prop = exportKey === "module" ? "exports" : exportKey;
            if (target) Object.defineProperty(target, prop, { value: original, configurable: true, writable: true });
        }
    } catch {

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

const FIBER_TAGS: readonly string[] = ["Function", "Class", "Indeterminate", "HostRoot", "Portal", "DOM", "Text", "Fragment", "Mode", "ContextConsumer", "ContextProvider", "ForwardRef", "Profiler", "Suspense", "Memo", "SimpleMemo", "Lazy", "IncompleteClass", "DehydratedFragment", "SuspenseList", "Scope", "Offscreen", "LegacyHidden", "Cache", "TracingMarker", "HostHoistable", "HostSingleton", "HostResource"];

export function fiberFromKey(obj: object, prefix: string): ReactFiber | null {
    for (const key in obj) if (key.startsWith(prefix)) return (obj as Record<string, ReactFiber>)[key];
    return null;
}
export const getFiber = (el: Element): ReactFiber | null => fiberFromKey(el, "__reactFiber$");

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
    const name = type.displayName
        ? type.displayName
        : typeof type === "string"
          ? type
          : typeof type.name === "string" && type.name.length > 2
            ? type.name
            : type.render?.displayName
              ? type.render.displayName
              : type.WrappedComponent?.displayName
                ? `Wrapped(${type.WrappedComponent.displayName})`
                : null;
    return { name, tagType, isMinified: !name && typeof type.name === "string" && type.name.length <= 2, key };
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
    if (d < 2 && keys.length <= 4) return Object.fromEntries(keys.map(k => [k, serializeValue(obj[k], d + 1)]));
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
            if (tag & HOOK_EFFECT_FLAGS.LAYOUT) return "useLayoutEffect";
            if (tag & HOOK_EFFECT_FLAGS.INSERTION) return "useInsertionEffect";
            if (tag & HOOK_EFFECT_FLAGS.PASSIVE) return "useEffect";
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

const isCssClassValue = (v: unknown): v is string => typeof v === "string" && CSS_CLASS_RE.test(v);

function isCSSModule(exports: unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const keys = Object.keys(exports);
    return keys.length >= 3 && keys.every(k => isCssClassValue((exports as Record<string, unknown>)[k]));
}

function buildCSSIndex(): CSSIndexCache {
    const index = new Map<string, CSSClassEntry>();
    const modules = new Map<string, CSSModuleInfo>();

    for (const [id, mod] of moduleEntries()) {
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
    const sorted = [...modules]
        .map(([moduleId, info]) => ({ moduleId, classCount: info.classCount, hash: info.hash, sampleClasses: Object.values(info.classes).slice(0, LIMITS.CSS.SAMPLE_CLASSES) }))
        .sort((a, b) => b.classCount - a.classCount);
    const totalClasses = sorted.reduce((n, m) => n + m.classCount, 0);

    return {
        totalModules: modules.size,
        totalClasses,
        topModules: sorted.slice(0, LIMITS.CSS.TOP_MODULES),
    };
}

export function scanSingleOccurrences(source: string, regex: RegExp, extract: (m: RegExpExecArray) => { find: string; search: string; type: string } | null, max = 10): AnchorCandidate[] {
    const seen = new Map<string, { entry: { find: string; search: string; type: string }; index: number; count: number }>();
    let m: RegExpExecArray | null;

    while ((m = regex.exec(source))) {
        const entry = extract(m);
        if (!entry) continue;
        const e = seen.get(entry.find);
        if (e) e.count++;
        else seen.set(entry.find, { entry, index: m.index, count: 1 });
    }

    const results: AnchorCandidate[] = [];
    for (const { entry, index, count } of seen.values()) if (count === 1 && results.length < max) results.push({ ...entry, index });
    return results;
}

export function collectMethods(obj: unknown, limit = 20): string[] {
    if (!obj || typeof obj !== "object") return [];
    const rec = obj as Record<string, unknown>;
    const methods = new Set<string>();
    for (const k of Object.keys(obj)) {
        if (typeof rec[k] === "function") methods.add(k);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
            if (k !== "constructor" && typeof rec[k] === "function") methods.add(k);
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
    const mod = moduleAt(id);
    if (!mod?.exports) return null;
    const exp = mod.exports as Record<string, HintExport | string | undefined> & HintExport;
    const dn = safeCall(() => exp.default?.displayName ?? exp.displayName ?? exp.default?.name, undefined);
    if (typeof dn === "string" && dn.length > 1) return dn;
    let keys: string[];
    try { keys = Object.keys(exp); } catch { return null; }
    if (keys.length >= 1 && keys.length <= 3 && keys.every(k => isCssClassValue(exp[k]))) return "[css]";
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
    return typeof find === "string" ? find : find?.toString() ?? "";
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

export function buildPatchRegex(match: string | RegExp): RegExp {
    if (match instanceof RegExp) return canonicalizeMatch(match);
    const parsed = parseRegex(match);
    if (parsed) return canonicalizeMatch(parsed);
    return getCachedRegex(escapeRegExp(canonicalizeMatch(match)));
}

export function clamp(v: number | undefined, def: number, lo: number, hi: number): number {
    return Math.min(Math.max(v ?? def, lo), hi);
}

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

interface IntlProbe {
    intlKey: string;
    intlStatus: "key_valid_but_unused" | "key_not_found";
}

const _intlKeyPattern = /#\{intl::([A-Z][A-Z0-9_]*)/;

export function intlFind(hash: string, key: string | null | undefined): string {
    return key ? `#{intl::${key}}` : `#{intl::${hash}::raw}`;
}

export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const remainingMs = (expiresAt: number): number => Math.max(0, expiresAt - Date.now());

export function stripGlobal(regex: RegExp): RegExp {
    return regex.global ? new RegExp(regex.source, regex.flags.replace("g", "")) : regex;
}

export function ownAndProtoNames(obj: object, proto: object | null): string[] {
    return [...new Set([...(proto ? Object.getOwnPropertyNames(proto) : []), ...Object.getOwnPropertyNames(obj)])];
}

export function healthStatus(broken: number, total: number): "HEALTHY" | "DEGRADED" | "BROKEN" {
    return broken === 0 ? "HEALTHY" : broken < total / 2 ? "DEGRADED" : "BROKEN";
}

export function checkJsSyntax(code: string): string | null {
    try { new Function(code); return null; } catch (e) { return errMsg(e); }
}

export function exportKeysPreview(exports: unknown): string[] | undefined {
    return typeof exports === "object" && exports ? Object.keys(exports).slice(0, LIMITS.MODULE.EXPORT_KEYS_PREVIEW) : undefined;
}

export function* iterIntlHashes(source: string): Generator<{ hash: string; key: string | null; index: number }> {
    for (const regex of [createIntlHashDotRegex(), createIntlHashBracketRegex()]) {
        let m: RegExpExecArray | null;
        while ((m = regex.exec(source))) yield { hash: m[1], key: getIntlKeyFromHash(m[1]), index: m.index };
    }
}

export function* fibersUp(fiber: ReactFiber | null, maxDepth: number): Generator<{ fiber: ReactFiber; depth: number }> {
    let current = fiber, depth = 0;
    while (current && depth < maxDepth) {
        yield { fiber: current, depth };
        current = current.return ?? null;
        depth++;
    }
}

export function stopAllResult(map: { size: number }, cleanupAll: () => void): { stopped: number } {
    const stopped = map.size;
    cleanupAll();
    return { stopped };
}

export function stopOneResult<C>(map: Map<number, { captures: C[] }>, id: number, label: string, cleanup: (id: number) => boolean, summarize: (c: C[]) => Record<string, unknown>) {
    const s = map.get(id);
    if (!s) return { error: true as const, message: `${label} ${id} not found` };
    const { captures } = s;
    cleanup(id);
    return { id, stopped: true, captureCount: captures.length, ...summarize(captures) };
}

export function typeSample(obj: Record<string, unknown>, n: number): Record<string, string> {
    return Object.fromEntries(Object.keys(obj).slice(0, n).map(k => [k, typeof obj[k]]));
}

export function probeIntlKey(rawFind: string): IntlProbe | null {
    const m = rawFind.match(_intlKeyPattern);
    if (!m?.[1]) return null;
    const hash = runtimeHashMessageKey(m[1]);
    return { intlKey: m[1], intlStatus: intlHashExistsInDefinitions(hash) ? "key_valid_but_unused" : "key_not_found" };
}

export const safeCall = tryOrElse;
export { isObject };

export function safeProto(obj: object | null | undefined): object | null {
    if (!obj) return null;
    try { return Object.getPrototypeOf(obj); } catch { return null; }
}

export function filterBySubstring<T>(items: readonly T[], query: string, key: (t: T) => string): T[] {
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

export function missingArg(name: string): { error: true; message: string } {
    return { error: true, message: `${name} required` };
}

export function moduleNotFound(id: string): { error: true; message: string } {
    return { error: true, message: `Module ${id} not found` };
}

export function getDescriptor(obj: object, proto: object | null, name: string): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(obj, name) ?? (proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined);
}

export function compileFilterRegex(pattern: string, flags = "i"): RegExp | null {
    try { return new RegExp(pattern, flags); } catch { return null; }
}

export function compileFilterRegexOrError(pattern: string, tool: string): RegExp | ToolError {
    const regex = compileFilterRegex(pattern);
    if (regex) return regex;
    mcpLogger.warn(`${tool}: invalid filter regex "${pattern}"`);
    return { error: true, message: `Invalid filter regex: ${pattern}` };
}

export { findStore, getIntlMessageFromHash, runtimeHashMessageKey };
