/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";
import { factoryListeners, filters, wreq } from "@webpack";
import { Flux } from "@webpack/common";
import { loadLazyChunks } from "debug/loadLazyChunks";

import { ModuleToolArgs, ModuleWatch, ToolResult, WebpackExport, WebpackModule } from "../types";
import {
    clearBatchResultsCache,
    clearModuleSourceCache,
    countModuleMatchesFast,
    extractModule,
    getIntlKeyFromHash,
    getModulePatchedBy,
    getModuleSource,
    invalidateModuleIdCache,
    moduleWatchState,
    parseRegex,
    searchModulesOptimized,
} from "./utils";

type ModuleMatch = { id: string; exports: unknown; key: string };

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
        if (moduleWatchState.isLoadingLazy) return { error: true, message: "Lazy chunk loading already in progress" };

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

            moduleWatchState.lastLazyLoadResult = { loadedAt: Date.now(), modulesBefore, modulesAfter, newModules };

            return {
                success: true,
                modulesBefore,
                modulesAfter,
                newModules,
                loadedBefore,
                loadedAfter,
                newLoaded,
                message: newModules > 0 ? `Loaded ${newModules} new module factories and ${newLoaded} new module instances` : "All lazy chunks were already loaded"
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
            truncated: truncated || undefined
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
        if (!mod?.exports) return { found: false, message: `Module ${id} not found or not loaded` };

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

        const searchPattern = parseRegex(pattern) ?? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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

        return { found: true, id, hasPatches: true, patchedBy, originalSize: original.length, patchedSize: patched.length, original: original.slice(0, maxLength), patched: patched.slice(0, maxLength) };
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
        const filter = (m: unknown) => {
            if (typeof m !== "function") return false;
            const str = Function.prototype.toString.call(m);
            return parsedCode.every(c => str.includes(c));
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

    if (className) {
        const lower = className.toLowerCase();
        const filter = (m: unknown) => {
            if (!m || typeof m !== "object") return false;
            const keys = Object.keys(m);
            return keys.length > 0 && keys.some(k => typeof (m as Record<string, unknown>)[k] === "string" && ((m as Record<string, unknown>)[k] as string).includes("_") && k.toLowerCase().includes(lower));
        };
        const mods = findModulesWithIds(filter, limit);

        const matches = mods.map(m => {
            const obj = m.exports as Record<string, string>;
            const keys = Object.keys(obj);
            const matchingClasses = keys.filter(k => k.toLowerCase().includes(lower) && typeof obj[k] === "string");
            const classes: Record<string, string> = {};
            for (const k of matchingClasses.slice(0, 10)) classes[k] = obj[k];
            return { moduleId: m.id, classes };
        });

        return { count: mods.length, matches };
    }

    if (exportName) {
        const matches: Array<{ moduleId: string; exportKey: string; type: string; displayName?: string; source?: string }> = [];

        const common = (Vencord as unknown as { Webpack?: { Common?: Record<string, unknown> } }).Webpack?.Common ?? {};
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
            tip: matches.length ? (commonValue ? `Available as Vencord.Webpack.Common.${exportName}` : undefined) : (commonValue ? `Found in Webpack.Common but module ID could not be resolved. Use Vencord.Webpack.Common.${exportName}` : `No export named "${exportName}" found`)
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
        source = source.replace(/\.t\.([A-Za-z0-9+/]{6})/g, (match, hash: string) => {
            const key = getIntlKeyFromHash(hash);
            if (key) { annotations.push({ hash, key }); return `.t[/*${key}*/]`; }
            return match;
        });
        source = source.replace(/\.t\["([A-Za-z0-9+/]{6,8})"\]/g, (match, hash: string) => {
            const key = getIntlKeyFromHash(hash);
            if (key) { annotations.push({ hash, key }); return `.t[/*${key}*/]`; }
            return match;
        });

        const maxLen = Math.min(maxLength, 50000);
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

        const candidates: Array<{ find: string; type: string; unique: boolean; moduleCount: number; intlKey?: string }> = [];
        const seen = new Set<string>();

        const addCandidate = (find: string, searchStr: string, type: string, intlKey?: string) => {
            if (seen.has(find) || find.length < 8) return;
            seen.add(find);
            const count = countModuleMatchesFast(searchStr, 3);
            candidates.push({ find, type, unique: count === 1, moduleCount: count, intlKey });
        };

        const intlHashPattern = /\.t\.([A-Za-z0-9+/]{6})/g;
        const intlBracketPattern = /\.t\["([A-Za-z0-9+/]{6,8})"\]/g;
        for (const regex of [intlHashPattern, intlBracketPattern]) {
            let m;
            while ((m = regex.exec(source))) {
                const hash = m[1];
                const key = getIntlKeyFromHash(hash);
                const findStr = key ? `#{intl::${key}}` : `#{intl::${hash}::raw}`;
                addCandidate(findStr, `.${hash}`, "intl", key ?? undefined);
            }
        }

        const stringPattern = /"([^"]{8,60})"/g;
        let m;
        while ((m = stringPattern.exec(source))) {
            const str = m[1];
            if (/^[a-z0-9_]+$/i.test(str) && !str.includes("\\")) addCandidate(str, str, "string");
        }

        const propPattern = /([a-zA-Z_$][\w$]{3,30}):/g;
        const propCounts = new Map<string, number>();
        while ((m = propPattern.exec(source))) {
            const prop = m[1];
            propCounts.set(prop, (propCounts.get(prop) ?? 0) + 1);
        }
        for (const [prop] of [...propCounts].filter(([, c]) => c === 1).slice(0, 10)) {
            addCandidate(`${prop}:`, `${prop}:`, "prop");
        }

        candidates.sort((a, b) => {
            if (a.unique !== b.unique) return a.unique ? -1 : 1;
            const typeOrder = { intl: 0, string: 1, prop: 2 };
            return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
        });

        return { id, sourceSize: source.length, candidateCount: candidates.length, suggestions: candidates.slice(0, 15) };
    }

    if (pattern || action === "find") {
        const results = searchModulesOptimized(source => {
            if (!pattern) return false;
            const regex = parseRegex(pattern);
            return regex ? regex.test(source) : source.includes(pattern);
        }, limit);

        return { count: results.length, ids: results, preview: results.map(moduleId => ({ id: moduleId, snippet: getModuleSource(moduleId).slice(0, 200) })) };
    }

    return { error: true, message: "Specify action or search criteria: props, code, displayName, className, exportName, exportValue, pattern, or id" };
}
