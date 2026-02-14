/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";
import { loadLazyChunks } from "debug/loadLazyChunks";

import { AnchorCandidate, CompEntry, ModuleMatch, ModuleToolArgs, ModuleWatch, SuggestCandidate, ToolResult, WebpackExport, WebpackModule } from "../types";
import { DesignTokensModule, factoryListeners, filters, Flux, getCommonModules, UIBarrelModule, wreq } from "../webpack";
import { ANCHOR_TYPE_ORDER, CONTEXT, createIntlHashBracketRegex, createIntlHashDotRegex, ENUM_MEMBER_RE, FUNC_CALL_RE, ICON_DETECT_RE, IDENT_ASSIGN_RE, LIMITS, MANA_COMPONENT_SINGLE_RE, NOISE_STRINGS, STORE_NAME_RE, STRING_LITERAL_RE } from "./constants";
import {
    clearBatchResultsCache,
    clearComponentIndexCache,
    clearCSSIndexCache,
    clearModuleSourceCache,
    compareByAnchorType,
    countModuleMatchesFast,
    extractModule,
    extractPropsFromFunction,
    getComponentIndex,
    getCSSIndex,
    getCSSModuleStats,
    getIntlKeyFromHash,
    getModulePatchedBy,
    getModuleSource,
    invalidateModuleIdCache,
    isRenderedClassName,
    moduleWatchState,
    parseRegex,
    scanSingleOccurrences,
    searchModulesOptimized,
} from "./utils";

function findModulesWithIds(filter: (m: unknown) => boolean, max: number): ModuleMatch[] {
    const results: ModuleMatch[] = [];
    for (const [id, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
        if (results.length >= max || !mod?.loaded || mod.exports == null) continue;
        const exp = mod.exports;
        if (filter(exp)) { results.push({ id, exports: exp, key: "module" }); continue; }
        if (typeof exp !== "object") continue;
        for (const key of Object.keys(exp)) {
            const nested = exp[key];
            if (nested && filter(nested)) {
                results.push({ id, exports: nested, key });
                break;
            }
        }
    }
    return results;
}

export async function handleModuleTool(args: ModuleToolArgs): Promise<ToolResult> {
    const { action, id, props, code, displayName, className, exportName, exportValue, pattern } = args;
    const limit = args.limit ?? 20;
    const maxLength = Math.min(args.maxLength ?? 50000, 100000);

    if (action === "stats" || (!action && !id && !props && !code && !displayName && !className && !exportName && !exportValue && !pattern)) {
        const totalModules = Object.keys(wreq.m).length;
        const loadedModules = Object.keys(wreq.c).length;
        let patchedCount = 0;
        for (const moduleId of Object.keys(wreq.m)) {
            if (getModulePatchedBy(moduleId).length) patchedCount++;
        }
        return {
            totalModules,
            loadedModules,
            patchedModules: patchedCount,
            stores: Flux.Store.getAll().length,
            loadedPercentage: Math.round((loadedModules / totalModules) * 100)
        };
    }

    if (action === "ids") {
        const ids = Object.keys(wreq.m).slice(0, limit);
        return { total: Object.keys(wreq.m).length, ids };
    }

    if (action === "loadLazy") {
        if (moduleWatchState.isLoadingLazy) return { error: true, message: "Lazy load already in progress" };

        const modulesBefore = Object.keys(wreq.m).length;
        const loadedBefore = Object.keys(wreq.c).length;
        moduleWatchState.isLoadingLazy = true;

        try {
            await loadLazyChunks();
            const modulesAfter = Object.keys(wreq.m).length;
            const loadedAfter = Object.keys(wreq.c).length;
            const newModules = modulesAfter - modulesBefore;
            const newLoaded = loadedAfter - loadedBefore;

            invalidateModuleIdCache();
            clearModuleSourceCache();
            clearBatchResultsCache();
            clearCSSIndexCache();
            clearComponentIndexCache();

            moduleWatchState.lastLazyLoadResult = { loadedAt: Date.now(), modulesBefore, modulesAfter, newModules };

            return {
                success: true,
                modulesBefore,
                modulesAfter,
                newModules,
                loadedBefore,
                loadedAfter,
                newLoaded,
                message: newModules > 0 ? `Loaded ${newModules} factories, ${newLoaded} instances` : "Lazy chunks already loaded"
            };
        } finally {
            moduleWatchState.isLoadingLazy = false;
        }
    }

    if (action === "watch") {
        const duration = Math.min(Math.max(args.duration ?? 30000, 5000), 120000);
        const maxCaptures = Math.min(args.maxCaptures ?? 100, 500);
        const filterRegex = args.filter ? parseRegex(args.filter) ?? new RegExp(args.filter, "i") : null;

        const watchId = moduleWatchState.nextId++;
        const now = Date.now();
        const baselineCount = Object.keys(wreq.m).length;
        const seenModules = new Set(Object.keys(wreq.m));

        const watch: ModuleWatch = {
            id: watchId,
            filter: filterRegex,
            newModules: [],
            maxCaptures,
            startedAt: now,
            expiresAt: now + duration,
            baselineCount,
            listener: null
        };

        const listener = () => {
            if (watch.newModules.length >= watch.maxCaptures) return;
            for (const modId of Object.keys(wreq.m)) {
                if (seenModules.has(modId)) continue;
                seenModules.add(modId);
                const source = String(wreq.m[modId]);
                if (filterRegex && !filterRegex.test(source)) continue;
                watch.newModules.push({ id: modId, ts: Date.now(), size: source.length });
            }
        };

        watch.listener = listener;
        factoryListeners.add(listener);
        moduleWatchState.active.set(watchId, watch);

        return { id: watchId, filter: args.filter ?? "*", duration, maxCaptures, baselineCount };
    }

    if (action === "watchGet") {
        const { watchId } = args;

        if (watchId === undefined) {
            const watches = [...moduleWatchState.active.values()].map(w => ({
                id: w.id,
                filter: w.filter?.source ?? "*",
                newModuleCount: w.newModules.length,
                elapsed: Date.now() - w.startedAt,
                remaining: Math.max(0, w.expiresAt - Date.now())
            }));
            return { activeWatches: watches.length, watches, lastLazyLoad: moduleWatchState.lastLazyLoadResult };
        }

        const watch = moduleWatchState.active.get(watchId);
        if (!watch) return { error: true, message: `Watch ${watchId} not found or expired` };

        const truncated = watch.newModules.length > 50;
        return {
            id: watchId,
            newModuleCount: watch.newModules.length,
            remaining: Math.max(0, watch.expiresAt - Date.now()),
            newModules: watch.newModules.slice(0, 50),
            truncated: truncated ? true : undefined
        };
    }

    if (action === "watchStop") {
        const { watchId } = args;

        if (watchId === undefined) {
            const count = moduleWatchState.active.size;
            for (const [wid, w] of moduleWatchState.active) {
                if (w.listener) factoryListeners.delete(w.listener);
                moduleWatchState.active.delete(wid);
            }
            return { stopped: count };
        }

        const watch = moduleWatchState.active.get(watchId);
        if (!watch) return { error: true, message: `Watch ${watchId} not found` };

        const { newModules } = watch;
        if (watch.listener) factoryListeners.delete(watch.listener);
        moduleWatchState.active.delete(watchId);
        return { id: watchId, stopped: true, newModuleCount: newModules.length, newModules: newModules.slice(0, 100) };
    }

    if (action === "size" && id) {
        const source = getModuleSource(id);
        if (!source) return { found: false, message: `Module ${id} not found` };
        return { id, size: source.length, sizeKB: Math.round(source.length / 1024 * 10) / 10 };
    }

    if ((action === "extract" || (!action && id)) && id) {
        if (!wreq.m[id]) return { error: true, message: `Module ${id} not found` };
        const patched = args.patched !== false;
        const source = extractModule(id, patched);
        const patchedBy = getModulePatchedBy(id);
        return { id, patched: patchedBy.length > 0, patchedBy, size: source.length, truncated: source.length > maxLength, source: source.slice(0, maxLength) };
    }

    if (action === "exports" && id) {
        const mod = wreq.c[id] as WebpackModule | undefined;
        if (!mod?.exports) return { found: false, message: `Module ${id} not loaded` };

        const exp = mod.exports;
        const exports: Record<string, { type: string; displayName?: string; preview?: string }> = {};

        for (const key of Object.keys(exp)) {
            const val = exp[key] as WebpackExport | null | undefined;
            const type = typeof val;
            const entry: { type: string; displayName?: string; preview?: string } = { type };
            if (val?.displayName) entry.displayName = val.displayName;
            if (type === "function") entry.preview = (val as unknown as () => void).toString().slice(0, 100);
            else if (type === "object" && val) entry.preview = Object.keys(val).slice(0, 10).join(", ");
            else if (type === "string") entry.preview = (val as unknown as string).slice(0, 50);
            exports[key] = entry;
        }

        return { found: true, id, hasDefault: "default" in exp, exportCount: Object.keys(exp).length, exports };
    }

    if (action === "context" && id && pattern) {
        const chars = args.chars ?? 100;
        const source = getModuleSource(id);
        if (!source) return { found: false, message: `Module ${id} not found` };

        const parsed = parseRegex(pattern);
        const searchPattern = parsed
            ? canonicalizeMatch(parsed)
            : new RegExp(canonicalizeMatch(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const match = source.match(searchPattern);
        if (!match?.index) return { found: false, pattern, message: "Pattern not found in module" };

        const start = Math.max(0, match.index - chars);
        const end = Math.min(source.length, match.index + match[0].length + chars);
        return { found: true, moduleId: id, matchIndex: match.index, matchLength: match[0].length, context: source.slice(start, end), matchedText: match[0] };
    }

    if (action === "diff" && id) {
        const original = getModuleSource(id);
        if (!original) return { found: false, message: `Module ${id} not found` };

        const patched = extractModule(id, true);
        const patchedBy = getModulePatchedBy(id);
        if (!patchedBy.length) return { id, patched: false };

        const patchedClean = patched.startsWith("//") ? patched.slice(patched.indexOf("\n") + 1) : patched;

        const pad = LIMITS.MODULE.DIFF_CONTEXT_PAD;
        const maxRegionLen = LIMITS.MODULE.DIFF_MAX_REGION_LEN;
        const changes: Array<{ offset: number; original: string; patched: string }> = [];

        let oi = 0, pi = 0;
        while (oi < original.length && pi < patchedClean.length) {
            if (original[oi] === patchedClean[pi]) { oi++; pi++; continue; }

            const changeStart = oi;
            const pChangeStart = pi;

            let bestOEnd = -1, bestPEnd = -1;
            for (let look = 1; look <= LIMITS.MODULE.DIFF_RESYNC_WINDOW && bestOEnd < 0; look++) {
                for (let oShift = 0; oShift <= look; oShift++) {
                    const pShift = look - oShift;
                    const oPos = oi + oShift;
                    const pPos = pi + pShift;
                    if (oPos >= original.length || pPos >= patchedClean.length) continue;
                    let match = 0;
                    while (match < LIMITS.MODULE.DIFF_RESYNC_MATCH && oPos + match < original.length && pPos + match < patchedClean.length && original[oPos + match] === patchedClean[pPos + match]) match++;
                    if (match >= LIMITS.MODULE.DIFF_RESYNC_MATCH) { bestOEnd = oPos; bestPEnd = pPos; break; }
                }
            }

            if (bestOEnd < 0) {
                changes.push({
                    offset: changeStart,
                    original: original.slice(Math.max(0, changeStart - pad), original.length).slice(0, maxRegionLen),
                    patched: patchedClean.slice(Math.max(0, pChangeStart - pad), patchedClean.length).slice(0, maxRegionLen)
                });
                break;
            }

            const oSlice = original.slice(Math.max(0, changeStart - pad), bestOEnd + pad).slice(0, maxRegionLen);
            const pSlice = patchedClean.slice(Math.max(0, pChangeStart - pad), bestPEnd + pad).slice(0, maxRegionLen);
            changes.push({ offset: changeStart, original: oSlice, patched: pSlice });

            oi = bestOEnd;
            pi = bestPEnd;

            if (changes.length >= LIMITS.MODULE.DIFF_MAX_REGIONS) break;
        }

        return { found: true, id, hasPatches: true, patchedBy, originalSize: original.length, patchedSize: patchedClean.length, changeCount: changes.length, changes };
    }

    if (action === "deps" && id) {
        const source = getModuleSource(id);
        if (!source) return { found: false, message: `Module ${id} not found` };

        const deps = new Set<string>();
        let depMatch: RegExpExecArray | null;
        const depPattern = /\b\w\((\d+)\)/g;
        while ((depMatch = depPattern.exec(source))) deps.add(depMatch[1]);

        return { found: true, id, dependencyCount: deps.size, dependencies: [...deps].sort((a, b) => Number(a) - Number(b)) };
    }

    if (props?.length) {
        const filter = filters.byProps(...props);
        const mods = findModulesWithIds(filter, args.all ? limit : 1);
        if (!mods.length) return { found: false, message: "No module found with those props" };

        if (args.all) {
            return {
                count: mods.length,
                filterType: "props",
                modules: mods.map((m, i) => ({
                    index: i,
                    moduleId: m.id,
                    exportKey: m.key,
                    type: typeof m.exports,
                    keys: typeof m.exports === "object" && m.exports ? Object.keys(m.exports).slice(0, 30) : undefined,
                    sample: typeof m.exports === "object" && m.exports ? Object.fromEntries(Object.keys(m.exports).slice(0, 10).map(k => [k, typeof (m.exports as Record<string, unknown>)[k]])) : typeof m.exports === "function" ? (m.exports as Function).toString().slice(0, 200) : String(m.exports)
                }))
            };
        }
        const m = mods[0];
        const mod = m.exports as Record<string, unknown>;
        return { found: true, moduleId: m.id, exportKey: m.key, keys: Object.keys(mod), sample: Object.fromEntries(Object.keys(mod).slice(0, 20).map(k => [k, typeof mod[k]])) };
    }

    if (code?.length) {
        const parsedCode = code.map(c => canonicalizeMatch(c));
        const byCode = (m: unknown) => {
            if (typeof m !== "function") return false;
            const str = Function.prototype.toString.call(m);
            return parsedCode.every(c => str.includes(c));
        };
        const filter = (m: unknown) => {
            let inner = m;
            while (inner != null) {
                if (byCode(inner)) return true;
                if (!(inner as any).$$typeof) return false;
                if ((inner as any).type) inner = (inner as any).type;
                else if ((inner as any).render) inner = (inner as any).render;
                else return false;
            }
            return false;
        };
        const mods = findModulesWithIds(filter, args.all ? limit : 1);
        if (!mods.length) return { found: false, message: "No module found with that code" };

        if (args.all) {
            return {
                count: mods.length,
                filterType: "code",
                modules: mods.map((m, i) => ({
                    index: i,
                    moduleId: m.id,
                    exportKey: m.key,
                    type: typeof m.exports,
                    source: typeof m.exports === "function" ? (m.exports as Function).toString().slice(0, 200) : undefined,
                    keys: typeof m.exports === "object" && m.exports ? Object.keys(m.exports).slice(0, 30) : undefined
                }))
            };
        }
        const m = mods[0];
        if (typeof m.exports === "function") return { found: true, moduleId: m.id, exportKey: m.key, type: "function", source: (m.exports as Function).toString().slice(0, 5000) };
        return { found: true, moduleId: m.id, exportKey: m.key, type: typeof m.exports, keys: Object.keys(m.exports as object) };
    }

    if (displayName) {
        const exact = args.exact ?? false;
        const lower = displayName.toLowerCase();
        const matches: Array<{ moduleId: string; exportKey: string; displayName: string; type: string; keys?: string[] }> = [];

        for (const [modId, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
            if (matches.length >= limit || !mod?.exports) continue;
            const exp = mod.exports;

            const checkExport = (val: WebpackExport | null | undefined, key: string) => {
                if (!val) return;
                const dn = val.displayName ?? val.name;
                if (typeof dn !== "string") return;
                const isMatch = exact ? dn === displayName || dn.toLowerCase() === lower : dn.toLowerCase().includes(lower);
                if (isMatch) {
                    const hasRender = typeof val === "function" && (val as { prototype?: { render?: unknown } }).prototype?.render;
                    matches.push({
                        moduleId: modId,
                        exportKey: key,
                        displayName: dn,
                        type: typeof val === "function" ? (hasRender ? "Component" : "Function") : "Object",
                        keys: typeof val === "object" ? Object.keys(val).slice(0, 15) : undefined
                    });
                }
            };

            checkExport(exp.default as WebpackExport | undefined, "default");
            checkExport(exp as WebpackExport, "module");
            for (const key of Object.keys(exp).slice(0, 10)) {
                if (key !== "default") checkExport(exp[key] as WebpackExport | undefined, key);
            }
        }

        return { count: matches.length, matches };
    }

    if (action === "components") {
        const idx = getComponentIndex();

        if (id) {
            const mod = wreq.c[id] as WebpackModule | undefined;
            if (!mod?.exports) return { error: true, message: `Module ${id} not loaded` };
            const exp = mod.exports;
            const nonIcons: CompEntry[] = [];
            const iconKeys: string[] = [];

            const checkFn = (val: unknown, key: string) => {
                if (typeof val !== "function") return;
                const fn = val as Function & { displayName?: string };
                const src = fn.toString().slice(0, 500);
                if (ICON_DETECT_RE.test(src.slice(0, 200))) { iconKeys.push(key); return; }
                const entry: CompEntry = { key };
                if (fn.displayName) entry.displayName = fn.displayName;
                const props = extractPropsFromFunction(fn);
                if (props.length) entry.props = props;
                const manaMatch = src.match(MANA_COMPONENT_SINGLE_RE);
                if (manaMatch) entry.manaType = manaMatch[1];
                if (entry.displayName || entry.props?.length || entry.manaType) nonIcons.push(entry);
            };

            checkFn(exp, "module");
            checkFn(exp.default, "default");
            if (typeof exp === "object") {
                for (const [k, v] of Object.entries(exp)) {
                    if (k !== "default") checkFn(v, k);
                }
            }

            const components = nonIcons.slice(0, LIMITS.COMPONENT.MAX_MATCHES);

            const storyMatch = idx.stories.find(s => s.moduleId === id);
            return { moduleId: id, componentCount: nonIcons.length, iconCount: iconKeys.length, components, story: storyMatch ?? undefined };
        }

        if (className) {
            const lower = className.toLowerCase();
            const matches: Array<{ name: string; source: string; moduleId?: string; docs?: string; manaType?: string; controls?: Record<string, unknown> }> = [];

            for (const story of idx.stories) {
                if (matches.length >= LIMITS.COMPONENT.MAX_MATCHES) break;
                if (story.title.toLowerCase().includes(lower) || story.name.toLowerCase().includes(lower)) {
                    const mana = [...idx.manaTypes.entries()].find(([type]) => story.name.toLowerCase().includes(type) || story.title.toLowerCase().includes(type));
                    matches.push({
                        name: story.name,
                        source: "story",
                        moduleId: story.moduleId,
                        docs: story.docs,
                        manaType: mana?.[0],
                        controls: Object.keys(story.controls).length ? story.controls : undefined,
                    });
                }
            }

            for (const [type, moduleIds] of idx.manaTypes) {
                if (matches.length >= LIMITS.COMPONENT.MAX_MATCHES) break;
                if (type.toLowerCase().includes(lower)) {
                    if (!matches.some(m => m.manaType === type)) {
                        matches.push({ name: type, source: "mana", moduleId: moduleIds[0], manaType: type });
                    }
                }
            }

            for (const [dn, locations] of idx.displayNames) {
                if (matches.length >= LIMITS.COMPONENT.MAX_MATCHES) break;
                if (dn.toLowerCase().includes(lower)) {
                    if (!matches.some(m => m.name === dn)) {
                        matches.push({ name: dn, source: "displayName", moduleId: locations[0].moduleId });
                    }
                }
            }

            if (UIBarrelModule) {
                for (const [key] of Object.entries(UIBarrelModule)) {
                    if (matches.length >= LIMITS.COMPONENT.MAX_MATCHES) break;
                    if (key.toLowerCase().includes(lower) && !matches.some(m => m.name === key)) {
                        matches.push({ name: key, source: "uiBarrel", moduleId: idx.uiBarrelId ?? undefined });
                    }
                }
            }

            return { query: className, count: matches.length, matches };
        }

        return {
            stories: { count: idx.stories.length, titles: [...new Set(idx.stories.map(s => s.title))].slice(0, 30) },
            manaComponents: [...idx.manaTypes.keys()],
            displayNameComponents: idx.displayNames.size,
            uiBarrel: { moduleId: idx.uiBarrelId, ...idx.uiBarrelStats },
            iconsModule: { moduleId: idx.iconsModuleId, count: idx.uiBarrelStats.icons },
        };
    }

    if (action === "css") {
        if (className) {
            const { index, modules } = getCSSIndex();
            const lower = className.toLowerCase();
            const matches: Array<{ moduleId: string; hash: string; classCount: number; matchingClasses: Record<string, string> }> = [];

            for (const [modId, info] of modules) {
                const matching: Record<string, string> = {};
                for (const [k, v] of Object.entries(info.classes)) {
                    if (v.toLowerCase().includes(lower) || k.toLowerCase().includes(lower)) matching[k] = v;
                }
                if (Object.keys(matching).length) {
                    matches.push({ moduleId: modId, hash: info.hash, classCount: info.classCount, matchingClasses: matching });
                    if (matches.length >= limit) break;
                }
            }

            return { totalIndexed: index.size, count: matches.length, matches };
        }

        const stats = getCSSModuleStats();

        const tokenInfo: Record<string, unknown> = {};
        if (DesignTokensModule) {
            tokenInfo.semanticColors = Object.keys(DesignTokensModule.colors ?? {}).length;
            tokenInfo.rawColors = Object.keys(DesignTokensModule.unsafe_rawColors ?? {}).length;
            tokenInfo.radii = DesignTokensModule.radii;
            tokenInfo.spacing = DesignTokensModule.spacing;
        }
        if (DesignTokensModule?.shadows) {
            tokenInfo.shadows = Object.keys(DesignTokensModule.shadows).length;
        }

        return { ...stats, designTokens: Object.keys(tokenInfo).length ? tokenInfo : undefined };
    }

    if (className) {
        if (isRenderedClassName(className)) {
            const { index, modules } = getCSSIndex();
            const entry = index.get(className);
            if (entry) {
                const modInfo = modules.get(entry.moduleId);
                const allClasses = modInfo ? Object.fromEntries(
                    Object.entries(modInfo.classes).slice(0, LIMITS.CSS.MAX_CLASSES_PER_MODULE)
                ) : {};
                return {
                    found: true,
                    reverse: true,
                    moduleId: entry.moduleId,
                    hash: entry.hash,
                    matchedClass: { key: entry.key, value: className, semantic: entry.semantic },
                    classCount: modInfo?.classCount ?? 0,
                    allClasses,
                };
            }
        }

        const lower = className.toLowerCase();
        const filter = (m: unknown) => {
            if (!m || typeof m !== "object") return false;
            const keys = Object.keys(m);
            return keys.length > 0 && keys.some(k => {
                const v = (m as Record<string, unknown>)[k];
                if (typeof v !== "string") return false;
                return k.toLowerCase().includes(lower) || v.toLowerCase().includes(lower);
            });
        };
        const mods = findModulesWithIds(filter, limit);

        const matches = mods.map(m => {
            const obj = m.exports as Record<string, string>;
            const classes: Record<string, string> = {};
            for (const k of Object.keys(obj)) {
                const v = obj[k];
                if (typeof v !== "string") continue;
                if (k.toLowerCase().includes(lower) || v.toLowerCase().includes(lower)) {
                    classes[k] = v;
                    if (Object.keys(classes).length >= 10) break;
                }
            }
            return { moduleId: m.id, classes };
        });

        return { count: mods.length, matches };
    }

    if (exportName) {
        const matches: Array<{ moduleId: string; exportKey: string; type: string; displayName?: string; source?: string }> = [];

        const common = getCommonModules();
        const commonValue = common[exportName] as WebpackExport | undefined;
        let commonModuleId: string | undefined;

        if (commonValue) {
            const hasRender = typeof commonValue === "function" && (commonValue as { prototype?: { render?: unknown } }).prototype?.render;

            for (const [modId, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
                if (!mod?.exports) continue;
                const exp = mod.exports;

                if (exp === commonValue || exp.default === commonValue) {
                    commonModuleId = modId;
                    matches.push({
                        moduleId: modId,
                        exportKey: exp === commonValue ? "module.exports" : "default",
                        type: typeof commonValue === "function" ? (hasRender ? "Component" : "Function") : typeof commonValue,
                        displayName: commonValue.displayName ?? commonValue.name,
                        source: "Webpack.Common"
                    });
                    break;
                }

                for (const key of Object.keys(exp)) {
                    if (exp[key] === commonValue) {
                        commonModuleId = modId;
                        matches.push({
                            moduleId: modId,
                            exportKey: key,
                            type: typeof commonValue === "function" ? (hasRender ? "Component" : "Function") : typeof commonValue,
                            displayName: commonValue.displayName ?? commonValue.name,
                            source: "Webpack.Common"
                        });
                        break;
                    }
                }
                if (commonModuleId) break;
            }
        }

        for (const [modId, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
            if (matches.length >= limit || modId === commonModuleId || !mod?.exports) continue;
            const exp = mod.exports;

            const checkExport = (val: WebpackExport | null | undefined, key: string) => {
                if (!val) return;
                const nm = val.displayName ?? val.name;
                const hasRender = typeof val === "function" && (val as { prototype?: { render?: unknown } }).prototype?.render;
                if (nm === exportName || key === exportName) {
                    matches.push({
                        moduleId: modId,
                        exportKey: key,
                        type: typeof val === "function" ? (hasRender ? "Component" : "Function") : typeof val,
                        displayName: nm
                    });
                }
            };

            if (exp.default) checkExport(exp.default as WebpackExport, "default");
            for (const key of Object.keys(exp)) {
                if (key !== "default" && matches.length < limit) checkExport(exp[key] as WebpackExport | undefined, key);
            }
        }

        return {
            exportName,
            inWebpackCommon: !!commonValue,
            count: matches.length,
            matches,
            tip: matches.length ? (commonValue ? `Webpack.Common.${exportName}` : undefined) : (commonValue ? "In Webpack.Common but module ID unresolved" : `No export "${exportName}" found`)
        };
    }

    if (exportValue) {
        const filter = (m: unknown): boolean => !!m && typeof m === "object" && Object.values(m as object).includes(exportValue);
        const mods = findModulesWithIds(filter, limit);
        const matches = mods.map(m => {
            const obj = m.exports as Record<string, unknown>;
            const keys = Object.keys(obj);
            return { moduleId: m.id, keys: keys.slice(0, 20), matchingKeys: keys.filter(k => obj[k] === exportValue) };
        });

        return { value: exportValue, valueType: typeof exportValue, count: mods.length, matches };
    }

    if (action === "annotate" && id) {
        let source = args.patched !== false ? extractModule(id, true) : getModuleSource(id);
        if (!source) return { error: true, message: `Module ${id} not found` };

        const annotations: Array<{ hash: string; key: string }> = [];
        for (const regex of [createIntlHashDotRegex(), createIntlHashBracketRegex()]) {
            source = source.replace(regex, (match, hash: string) => {
                const key = getIntlKeyFromHash(hash);
                if (key) { annotations.push({ hash, key }); return `.t[/*${key}*/]`; }
                return match;
            });
        }

        const maxLen = Math.min(maxLength, CONTEXT.ANNOTATE_MAX_LENGTH);
        return {
            id,
            patched: args.patched !== false,
            patchedBy: getModulePatchedBy(id),
            annotationCount: annotations.length,
            size: source.length,
            truncated: source.length > maxLen,
            source: source.slice(0, maxLen)
        };
    }

    if (action === "suggest" && id) {
        const source = getModuleSource(id);
        if (!source) return { error: true, message: `Module ${id} not found` };

        const candidates: SuggestCandidate[] = [];
        const seen = new Set<string>();

        const addCandidate = (find: string, searchStr: string, type: string, intlKey?: string, unstable?: boolean) => {
            if (seen.has(find) || find.length < LIMITS.MODULE.SUGGEST_MIN_FIND_LEN) return;
            seen.add(find);
            const count = countModuleMatchesFast(searchStr, 3);
            candidates.push({ find, type, unique: count === 1, moduleCount: count, intlKey, unstable: unstable ? true : undefined });
        };

        const rawAnchors: AnchorCandidate[] = [];

        for (const regex of [createIntlHashDotRegex(), createIntlHashBracketRegex()]) {
            let m;
            while ((m = regex.exec(source))) {
                const hash = m[1];
                const key = getIntlKeyFromHash(hash);
                const findStr = key ? `#{intl::${key}}` : `#{intl::${hash}::raw}`;
                const searchStr = canonicalizeMatch(findStr);
                addCandidate(findStr, searchStr, "intl", key ?? undefined);
                rawAnchors.push({ find: findStr, search: searchStr, type: "intl", index: m.index, intlKey: key ?? undefined });
            }
        }

        {
            const re = STORE_NAME_RE();
            let m: RegExpExecArray | null;
            while ((m = re.exec(source))) {
                const find = `="${m[1]}"`;
                addCandidate(find, find, "storeName");
                rawAnchors.push({ find, search: find, type: "storeName", index: m.index });
            }
        }
        {
            const re = STRING_LITERAL_RE();
            let m: RegExpExecArray | null;
            while ((m = re.exec(source))) {
                if (NOISE_STRINGS.has(m[1]) || !/^[a-zA-Z][a-zA-Z0-9_./ -]{4,}$/.test(m[1])) continue;
                const type = m[1].includes(" ") ? "errorString" : "string";
                addCandidate(m[1], m[1], type);
                rawAnchors.push({ find: m[1], search: m[1], type, index: m.index });
            }
        }

        const anchorScans: Array<{ regex: RegExp; extract: (m: RegExpExecArray) => { find: string; search: string; type: string } | null }> = [
            { regex: /([a-zA-Z_$][\w$]{3,30}):/g, extract: m => ({ find: `${m[1]}:`, search: `${m[1]}:`, type: "prop" }) },
            { regex: FUNC_CALL_RE(), extract: m => ({ find: `.${m[1]}(`, search: `.${m[1]}(`, type: "funcCall" }) },
            { regex: ENUM_MEMBER_RE(), extract: m => ({ find: `.${m[1]}`, search: `.${m[1]}`, type: "enum" }) },
            { regex: IDENT_ASSIGN_RE(), extract: m => NOISE_STRINGS.has(m[1]) || /^[a-z]{1,2}$/.test(m[1]) ? null : { find: m[1], search: m[1], type: "ident" } },
        ];

        for (const { regex, extract } of anchorScans) {
            for (const anchor of scanSingleOccurrences(source, regex, extract)) {
                addCandidate(anchor.find, anchor.search, anchor.type);
                rawAnchors.push(anchor);
            }
        }

        const ctxSuffixes = [";", ")", ",", "}", "\""];
        const ctxPrefixes = ["=", "(", ",", "{", "\""];

        for (const c of [...candidates]) {
            if (c.unique || c.type === "intl" || c.type === "combined") continue;
            const idx = source.indexOf(c.find);
            if (idx < 0) continue;

            const before = source[idx - 1];
            const after = source[idx + c.find.length];

            for (const suf of ctxSuffixes) {
                if (after === suf) addCandidate(c.find + suf, c.find + suf, c.type + "+ctx");
            }
            for (const pre of ctxPrefixes) {
                if (before === pre && !(pre === "=" && source[idx - 2] === "!")) {
                    addCandidate(pre + c.find, pre + c.find, c.type + "+ctx");
                }
            }
        }

        const hasUnique = candidates.some(c => c.unique);
        if (!hasUnique && rawAnchors.length >= 2) {
            rawAnchors.sort((a, b) => a.index - b.index);
            for (let i = 0; i < rawAnchors.length && candidates.filter(c => c.unique).length < 5; i++) {
                for (let j = i + 1; j < rawAnchors.length; j++) {
                    const a = rawAnchors[i], b = rawAnchors[j];
                    const gap = b.index - (a.index + a.search.length);
                    if (gap < 0 || gap > LIMITS.MODULE.SUGGEST_MAX_COMBINED_GAP) continue;
                    const between = source.slice(a.index + a.search.length, b.index);
                    if (/(?<=[=:(,])[\w$]{2,}(?=[,)}\].:;(])/.test(between)) continue;
                    const combinedSearch = a.search + between + b.search;
                    const combinedFind = a.find + between + b.find;
                    if (combinedFind.length > LIMITS.MODULE.SUGGEST_MAX_COMBINED_LEN) continue;
                    addCandidate(combinedFind, combinedSearch, "combined");
                }
            }
        }

        candidates.sort((a, b) => {
            if (a.unstable !== b.unstable) return a.unstable ? 1 : -1;
            return compareByAnchorType(a, b, ANCHOR_TYPE_ORDER);
        });

        const topN = LIMITS.MODULE.SUGGEST_TOP_N;
        const result: SuggestCandidate[] = [];
        const typeBuckets = new Map<string, SuggestCandidate[]>();
        for (const c of candidates) {
            const base = c.type.replace("+ctx", "");
            const bucket = typeBuckets.get(base);
            if (bucket) bucket.push(c);
            else typeBuckets.set(base, [c]);
        }
        for (const [, bucket] of typeBuckets) {
            const pick = bucket.filter(c => c.unique).slice(0, 3);
            if (!pick.length) pick.push(...bucket.slice(0, 2));
            result.push(...pick);
        }
        if (result.length < topN) {
            for (const c of candidates) {
                if (result.length >= topN) break;
                if (!result.includes(c)) result.push(c);
            }
        }
        result.sort((a, b) => compareByAnchorType(a, b, ANCHOR_TYPE_ORDER));

        return { id, sourceSize: source.length, candidateCount: candidates.length, suggestions: result.slice(0, topN) };
    }

    if (pattern || action === "find") {
        if (!pattern) return { error: true, message: "pattern required for find action" };
        const parsed = parseRegex(pattern);
        const regex = parsed ? canonicalizeMatch(parsed) : null;
        const canonicalized = canonicalizeMatch(pattern);
        const results = searchModulesOptimized(source =>
            regex ? regex.test(source) : source.includes(canonicalized), limit);

        return {
            count: results.length, ids: results, preview: results.map(moduleId => {
                const source = getModuleSource(moduleId);
                const match = regex ? source.match(regex) : null;
                const idx = match?.index ?? source.indexOf(canonicalized);
                if (idx >= 0) {
                    const start = Math.max(0, idx - CONTEXT.SEARCH_SNIPPET);
                    const end = Math.min(source.length, idx + (match?.[0].length ?? canonicalized.length) + CONTEXT.SEARCH_SNIPPET + 100);
                    return { id: moduleId, snippet: source.slice(start, end) };
                }
                return { id: moduleId, snippet: source.slice(0, 200) };
            })
        };
    }

    return { error: true, message: "Specify action or search criteria" };
}
