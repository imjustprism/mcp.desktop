/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { factoryListeners, filters, find, findAll, wreq } from "@webpack";
import { Flux } from "@webpack/common";
import { loadLazyChunks } from "debug/loadLazyChunks";

import { ModuleToolArgs, ModuleWatch, ToolResult, WebpackExport, WebpackModule } from "../types";
import {
    clearBatchResultsCache,
    clearModuleSourceCache,
    extractModule,
    getModulePatchedBy,
    getModuleSource,
    invalidateModuleIdCache,
    moduleWatchState,
    parseRegex,
    searchModulesOptimized,
} from "./utils";

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
        if (args.all) {
            const mods = findAll(filters.byProps(...props));
            return {
                count: mods.length,
                filterType: "props",
                modules: mods.slice(0, limit).map((mod, i) => ({
                    index: i,
                    type: typeof mod,
                    keys: typeof mod === "object" && mod ? Object.keys(mod).slice(0, 30) : undefined,
                    sample: typeof mod === "object" && mod ? Object.fromEntries(Object.keys(mod).slice(0, 10).map(k => [k, typeof (mod as Record<string, unknown>)[k]])) : typeof mod === "function" ? mod.toString().slice(0, 200) : String(mod)
                }))
            };
        }
        const mod = find(filters.byProps(...props));
        if (!mod) return { found: false, message: "No module found with those props" };
        return { found: true, keys: Object.keys(mod), sample: Object.fromEntries(Object.keys(mod).slice(0, 20).map(k => [k, typeof (mod as Record<string, unknown>)[k]])) };
    }

    if (code?.length) {
        if (args.all) {
            const mods = findAll(filters.byCode(...code));
            return {
                count: mods.length,
                filterType: "code",
                modules: mods.slice(0, limit).map((mod, i) => ({
                    index: i,
                    type: typeof mod,
                    source: typeof mod === "function" ? mod.toString().slice(0, 200) : undefined,
                    keys: typeof mod === "object" && mod ? Object.keys(mod).slice(0, 30) : undefined
                }))
            };
        }
        const mod = find(filters.byCode(...code));
        if (!mod) return { found: false, message: "No module found with that code" };
        if (typeof mod === "function") return { found: true, type: "function", source: mod.toString().slice(0, 5000) };
        return { found: true, type: typeof mod, keys: Object.keys(mod as object) };
    }

    if (displayName) {
        const exact = args.exact ?? false;
        const lower = displayName.toLowerCase();
        const matches: Array<{ displayName: string; type: string; keys?: string[] }> = [];

        for (const mod of Object.values(wreq.c) as WebpackModule[]) {
            if (matches.length >= limit || !mod?.exports) continue;
            const exp = mod.exports;

            const checkExport = (val: WebpackExport | null | undefined) => {
                if (!val) return;
                const dn = val.displayName ?? val.name;
                if (typeof dn !== "string") return;
                const isMatch = exact ? dn === displayName || dn.toLowerCase() === lower : dn.toLowerCase().includes(lower);
                if (isMatch) {
                    const hasRender = typeof val === "function" && (val as { prototype?: { render?: unknown } }).prototype?.render;
                    matches.push({
                        displayName: dn,
                        type: typeof val === "function" ? (hasRender ? "Component" : "Function") : "Object",
                        keys: typeof val === "object" ? Object.keys(val).slice(0, 15) : undefined
                    });
                }
            };

            checkExport(exp.default as WebpackExport | undefined);
            checkExport(exp as WebpackExport);
            for (const key of Object.keys(exp).slice(0, 10)) {
                if (key !== "default") checkExport(exp[key] as WebpackExport | undefined);
            }
        }

        return { count: matches.length, matches };
    }

    if (className) {
        const lower = className.toLowerCase();
        const matches: Array<{ classes: Record<string, string> }> = [];

        const mods = findAll(m => {
            if (!m || typeof m !== "object") return false;
            const keys = Object.keys(m);
            return keys.length > 0 && keys.some(k => typeof (m as Record<string, unknown>)[k] === "string" && ((m as Record<string, unknown>)[k] as string).includes("_") && k.toLowerCase().includes(lower));
        });

        for (const mod of mods.slice(0, limit)) {
            const keys = Object.keys(mod as object);
            const matchingClasses = keys.filter(k => k.toLowerCase().includes(lower) && typeof (mod as Record<string, unknown>)[k] === "string");
            const classes: Record<string, string> = {};
            for (const k of matchingClasses.slice(0, 10)) classes[k] = (mod as Record<string, string>)[k];
            matches.push({ classes });
        }

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
            tip: !matches.length ? `No export named "${exportName}" found` : commonValue ? `Available as Vencord.Webpack.Common.${exportName}` : undefined
        };
    }

    if (exportValue) {
        const mods = findAll(m => m && typeof m === "object" && Object.values(m).includes(exportValue));
        const matches = mods.slice(0, limit).map(mod => {
            const keys = Object.keys(mod as object);
            return { keys: keys.slice(0, 20), matchingKeys: keys.filter(k => (mod as Record<string, unknown>)[k] === exportValue) };
        });

        return { value: exportValue, valueType: typeof exportValue, count: mods.length, matches };
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
