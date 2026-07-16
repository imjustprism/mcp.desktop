/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadLazyChunks } from "@debug/loadLazyChunks";
import { canonicalizeMatch } from "@utils/patches";

import { fingerprintModule } from "../finds/moduleFingerprint";
import { AnchorCandidate, ModuleMatch, ModuleToolArgs, ModuleWatch, SuggestCandidate, ToolResult, WebpackExport } from "../types";
import { factoryListeners, filters, Flux, getCommonModules, wreq } from "../webpack";
import {
    ANCHOR_TYPE_ORDER,
    CONTEXT,
    createIntlHashBracketRegex,
    createIntlHashDotRegex,
    DEFAULT_TOOL_LIMIT,
    ENUM_MEMBER_RE,
    FUNC_CALL_RE,
    IDENT_ASSIGN_RE,
    INTL_HASH_FULL_RE,
    JS_RESERVED_KEYWORDS,
    LIMITS,
    NOISE_STRINGS,
    STORE_NAME_RE,
    STRING_LITERAL_RE,
} from "./constants";
import { handleGenFinds } from "./gen_finds_tool";
import * as u from "./utils";

function findModuleMatches(filter: (m: unknown) => boolean, max: number): ModuleMatch[] {
    const results: ModuleMatch[] = [];
    for (const [id, mod] of u.moduleEntries()) {
        if (results.length >= max) break;
        if (!mod?.loaded || mod.exports == null) continue;
        const exp = mod.exports;
        if (filter(exp)) {
            results.push({ id, exports: exp, key: "module" });
            continue;
        }
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

const moduleMatchBase = (m: ModuleMatch, i: number) => ({ index: i, moduleId: m.id, hint: u.getModuleHint(m.id), exportKey: m.key, type: typeof m.exports });

export async function handleModule(args: ModuleToolArgs): Promise<ToolResult> {
    const { action, id, props, code, displayName, className, exportName, exportValue, pattern } = args;
    if (args.limit != null && args.limit < 1) return { error: true, message: "limit must be >= 1 (omit for default)" };
    if (args.maxLength != null && args.maxLength < 1) return { error: true, message: "maxLength must be >= 1 (omit for default)" };
    const limit = args.limit ?? DEFAULT_TOOL_LIMIT;
    const maxLength = Math.min(args.maxLength ?? LIMITS.MODULE.SOURCE_MAXLENGTH_DEFAULT, LIMITS.MODULE.SOURCE_MAXLENGTH_CAP);

    u.cleanupExpiredModuleWatches();

    const hasSearchArg = id || props || code || displayName || className || exportName || exportValue || pattern;

    if (action === "stats" || (!action && !hasSearchArg)) {
        const moduleIds = Object.keys(wreq.m);
        const loadedModules = Object.keys(wreq.c).length;
        return {
            totalModules: moduleIds.length,
            loadedModules,
            patchedModules: moduleIds.filter(mid => u.getModulePatchedBy(mid).length).length,
            stores: Flux.Store.getAll().length,
            loadedPercentage: Math.round((loadedModules / moduleIds.length) * 100),
        };
    }

    if (action === "loadLazy") {
        if (u.moduleWatchState.isLoadingLazy) return { error: true, message: "Lazy load already in progress" };

        const modulesBefore = Object.keys(wreq.m).length;
        const loadedBefore = Object.keys(wreq.c).length;
        u.moduleWatchState.isLoadingLazy = true;

        try {
            await loadLazyChunks();
            const modulesAfter = Object.keys(wreq.m).length;
            const loadedAfter = Object.keys(wreq.c).length;
            const newModules = modulesAfter - modulesBefore;
            const newLoaded = loadedAfter - loadedBefore;

            u.invalidateModuleIdCache();
            u.clearModuleSourceCache();
            u.clearBatchResultsCache();
            u.clearCSSIndexCache();
            u.clearDependencyGraphCache();
            u.invalidateIdentityIndex();

            u.moduleWatchState.lastLazyLoadResult = { loadedAt: Date.now(), modulesBefore, modulesAfter, newModules };

            return {
                success: true,
                modulesBefore,
                modulesAfter,
                newModules,
                loadedBefore,
                loadedAfter,
                newLoaded,
                message: newModules > 0 ? `Loaded ${newModules} factories, ${newLoaded} instances` : "Lazy chunks already loaded",
            };
        } finally {
            u.moduleWatchState.isLoadingLazy = false;
        }
    }

    if (action === "watch") {
        if (args.maxCaptures === 0) return { error: true, message: "maxCaptures must be >= 1 (omit for default)" };
        const duration = u.clamp(args.duration, LIMITS.MODULE.WATCH_DURATION_DEFAULT_MS, LIMITS.MODULE.WATCH_DURATION_MIN_MS, LIMITS.MODULE.WATCH_DURATION_MAX_MS);
        const maxCaptures = Math.min(args.maxCaptures ?? LIMITS.MODULE.WATCH_MAX_CAPTURES_DEFAULT, LIMITS.MODULE.WATCH_MAX_CAPTURES_CAP);
        let filterRegex: RegExp | null = null;
        if (args.filter) {
            const r = u.parseRegex(args.filter) ?? u.compileFilterRegexOrError(args.filter, "module watch");
            if ("error" in r) return r;
            filterRegex = r;
        }

        const watchId = u.moduleWatchState.nextId++;
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
            listener: null,
        };

        const listener = () => {
            if (watch.newModules.length >= watch.maxCaptures) return;
            for (const modId of Object.keys(wreq.m)) {
                if (seenModules.has(modId)) continue;
                seenModules.add(modId);
                const source = String(wreq.m[modId]);
                if (filterRegex && !filterRegex.test(source)) continue;
                watch.newModules.push({ id: modId, ts: Date.now(), size: source.length });
                if (watch.newModules.length >= watch.maxCaptures) return;
            }
        };

        watch.listener = listener;
        factoryListeners.add(listener);
        u.moduleWatchState.active.set(watchId, watch);

        return { id: watchId, filter: args.filter ?? "*", duration, maxCaptures, baselineCount };
    }

    if (action === "watchGet") {
        const { watchId } = args;

        if (watchId === undefined) {
            const watches = [...u.moduleWatchState.active.values()].map(w => ({
                id: w.id,
                filter: w.filter?.source ?? "*",
                newModuleCount: w.newModules.length,
                elapsed: Date.now() - w.startedAt,
                remaining: u.remainingMs(w.expiresAt),
            }));
            return { activeWatches: watches.length, watches, lastLazyLoad: u.moduleWatchState.lastLazyLoadResult };
        }

        const watch = u.moduleWatchState.active.get(watchId);
        if (!watch) return { error: true, message: `Watch ${watchId} not found or expired` };

        return {
            id: watchId,
            newModuleCount: watch.newModules.length,
            remaining: u.remainingMs(watch.expiresAt),
            newModules: watch.newModules.slice(0, LIMITS.MODULE.WATCHGET_RESULT_SLICE),
            truncated: watch.newModules.length > LIMITS.MODULE.WATCHGET_RESULT_SLICE || undefined,
        };
    }

    if (action === "watchStop") {
        const { watchId } = args;

        if (watchId === undefined) return u.stopAllResult(u.moduleWatchState.active, u.cleanupAllModuleWatches);

        const watch = u.moduleWatchState.active.get(watchId);
        if (!watch) return { error: true, message: `Watch ${watchId} not found or expired` };

        const { newModules } = watch;
        u.cleanupModuleWatch(watchId);
        return { id: watchId, stopped: true, newModuleCount: newModules.length, newModules: newModules.slice(0, LIMITS.MODULE.WATCHSTOP_RESULT_SLICE) };
    }

    if (action === "functionAt") {
        if (!id) return u.missingArg("id");
        if (!pattern) return u.missingArg("pattern");

        const source = u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);

        const matchIdx = u.makePatternMatcher(pattern).firstIndex(source);
        if (matchIdx < 0) return { error: true, message: "Pattern not found in module" };

        let openBrace = -1;
        let braceCount = 0;

        for (let i = matchIdx; i < source.length && i < matchIdx + LIMITS.MODULE.FUNCTION_BRACE_SCAN_WINDOW; i++) {
            if (source[i] === "{") { openBrace = i; break; }
            if (source[i] === "}" || source[i] === ";") break;
        }

        if (openBrace < 0) {
            for (let i = matchIdx; i >= 0; i--) {
                if (source[i] === "}") braceCount++;
                else if (source[i] === "{") {
                    if (braceCount > 0) braceCount--;
                    else { openBrace = i; break; }
                }
            }
        }

        if (openBrace < 0) return { error: true, message: "Function boundary not found" };

        let headerStart = openBrace;
        while (headerStart > 0 && source[headerStart - 1] !== ";" && source[headerStart - 1] !== "}" && source[headerStart - 1] !== "\n" && (openBrace - headerStart) < LIMITS.MODULE.FUNCTION_HEADER_SCAN_LIMIT) headerStart--;

        let fnEnd = openBrace + 1;
        braceCount = 1;
        while (fnEnd < source.length && braceCount > 0) {
            const ch = source[fnEnd];
            if (ch === "{") braceCount++;
            else if (ch === "}") braceCount--;
            fnEnd++;
        }

        const fnSource = source.slice(headerStart, fnEnd);
        const maxLen = Math.min(maxLength, LIMITS.MODULE.FUNCTION_SOURCE_MAX);
        return {
            found: true,
            id,
            patternIndex: matchIdx,
            functionStart: headerStart,
            functionEnd: fnEnd,
            functionLength: fnEnd - headerStart,
            truncated: fnSource.length > maxLen,
            source: fnSource.slice(0, maxLen),
        };
    }

    if (action === "explain") {
        if (!id) return u.missingArg("id");
        const src = u.getModuleSource(id);
        if (!src) return u.moduleNotFound(id);
        const { forward, reverse } = u.buildDependencyGraph();
        const publicExports = u.parsePublicExports(id);
        const imports = (forward.get(id) ?? []).slice(0, 8).map(d => ({ id: d, hint: u.getModuleHint(d) }));
        const importedByCount = (reverse.get(id) ?? []).length;
        const patchedBy = u.getModulePatchedBy(id);
        const intlKeys = [...u.iterIntlHashes(src)].slice(0, LIMITS.MODULE.STRUCTURE_MAX_STRINGS).map(h => u.intlFind(h.hash, h.key));
        const stores = [...new Set([...src.matchAll(/\b([A-Z]\w+Store)\b/g)].map(mm => mm[1]))].slice(0, LIMITS.MODULE.STRUCTURE_VARIABLES_OUT);
        const dispatches = [...new Set([...src.matchAll(/type:"([A-Z][A-Z0-9_]+)"/g)].map(mm => mm[1]))].slice(0, LIMITS.MODULE.STRUCTURE_VARIABLES_OUT);
        const isComponent = /\.jsxs?[()]/.test(src) || (/\.createElement\(/.test(src) && !/document\.createElement/.test(src));
        const role = /registerStore|extends\s+[\w.]+\.Store\b/.test(src) || stores.some(s => src.includes(`class ${s}`))
            ? "store"
            : isComponent
              ? "component"
              : /RestAPI|Endpoints\./.test(src)
                ? "api"
                : Object.keys(publicExports).length >= 2 && src.length < 600
                  ? "barrel"
                  : "module";
        return {
            id,
            role,
            hint: u.getModuleHint(id),
            size: src.length,
            publicExports,
            imports,
            importedByCount,
            patchedBy: patchedBy.length ? patchedBy : undefined,
            touches: {
                intlKeys: intlKeys.length ? intlKeys : undefined,
                stores: stores.length ? stores : undefined,
                dispatches: dispatches.length ? dispatches : undefined,
            },
        };
    }

    if (action === "structure") {
        if (!id) return u.missingArg("id");
        const source = u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);

        const functions: Array<{ name: string; pos: number; params?: string }> = [];
        const classes: Array<{ name: string; pos: number; extends?: string }> = [];
        const strings: string[] = [];
        const assignments: Array<{ name: string; pos: number }> = [];

        const fnRe = /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(([^)]{0,80})\)/g;
        let m: RegExpExecArray | null;
        while ((m = fnRe.exec(source)) && functions.length < LIMITS.MODULE.STRUCTURE_MAX_FUNCTIONS) {
            if (!JS_RESERVED_KEYWORDS.has(m[1])) functions.push({ name: m[1], pos: m.index, params: m[2] || undefined });
        }

        const classRe = /\bclass\s+([a-zA-Z_$][\w$]*)(?:\s+extends\s+([a-zA-Z_$][\w$.]*))?\s*\{/g;
        while ((m = classRe.exec(source)) && classes.length < LIMITS.MODULE.STRUCTURE_MAX_CLASSES) classes.push({ name: m[1], pos: m.index, extends: m[2] || undefined });

        const methodRe = /(?:^|[;{}])([a-zA-Z_$][\w$]*)\s*\(([^)]{0,60})\)\s*\{/gm;
        while ((m = methodRe.exec(source)) && functions.length < LIMITS.MODULE.STRUCTURE_MAX_METHODS) {
            const name = m[1];
            if (!JS_RESERVED_KEYWORDS.has(name) && !functions.some(f => f.name === name)) functions.push({ name, pos: m.index, params: m[2] || undefined });
        }

        const strRe = /"([^"\\]{4,60})"/g;
        const strSeen = new Set<string>();
        while ((m = strRe.exec(source)) && strings.length < LIMITS.MODULE.STRUCTURE_MAX_STRINGS) {
            const s = m[1];
            if (strSeen.has(s)) continue;
            if (/\(0,\w/.test(s) || /\)\s*[?:,]/.test(s) || /jsx\(/.test(s) || /\.\w\.\w\.\w/.test(s)) continue;
            if (INTL_HASH_FULL_RE.test(s)) {
                const key = u.getIntlKeyFromHash(s);
                if (key) { strSeen.add(s); strings.push(u.intlFind(s, key)); continue; }
                const before = source.slice(Math.max(0, m.index - 5), m.index);
                if (before.endsWith(".t[")) { strSeen.add(s); strings.push(u.intlFind(s, null)); continue; }
                continue;
            }
            strSeen.add(s);
            strings.push(s);
        }

        const assignRe = /(?:let|const|var)\s+([a-zA-Z_$][\w$]{2,})(?:\s*=)/g;
        while ((m = assignRe.exec(source)) && assignments.length < LIMITS.MODULE.STRUCTURE_MAX_ASSIGNMENTS) assignments.push({ name: m[1], pos: m.index });

        const mod = u.moduleAt(id);
        const exportKeys = u.safeCall(() => u.exportKeysPreview(mod?.exports) ?? [], []);
        const hint = u.getModuleHint(id);
        const patchedBy = u.getModulePatchedBy(id);

        functions.sort((a, b) => a.pos - b.pos);

        return {
            id,
            hint,
            size: source.length,
            patchedBy: patchedBy.length ? patchedBy : undefined,
            exportKeys,
            classes: classes.length ? classes : undefined,
            functions: functions.slice(0, LIMITS.MODULE.STRUCTURE_MAX_FUNCTIONS),
            keyStrings: strings.length ? strings : undefined,
            variables: assignments.length ? assignments.slice(0, LIMITS.MODULE.STRUCTURE_VARIABLES_OUT).map(a => a.name) : undefined,
        };
    }

    if (action === "extract" && !id) return u.missingArg("id");

    if (id && (action === "extract" || !action)) {
        if (!wreq.m[id]) return u.moduleNotFound(id);
        const source = u.extractModule(id, args.patched !== false);
        const patchedBy = u.getModulePatchedBy(id);
        return { id, patched: patchedBy.length > 0, patchedBy, size: source.length, truncated: source.length > maxLength, source: source.slice(0, maxLength) };
    }

    if (action === "exports") {
        if (!id) return u.missingArg("id");
        const mod = u.moduleAt(id);
        if (!mod?.exports) return { error: true, message: `Module ${id} not loaded` };

        const exp = mod.exports;
        type ExportEntry = { type: string; displayName?: string; preview?: string; signature?: string };
        const exports: Record<string, ExportEntry> = {};

        for (const key of Object.keys(exp)) {
            const val = exp[key] as WebpackExport | null | undefined;
            const type = typeof val;
            const entry: ExportEntry = { type };
            if (val?.displayName) entry.displayName = val.displayName;
            if (type === "function") {
                const fnStr = String(val);
                const sigMatch = fnStr.match(/^(?:function\s*\w*|(?:\w+\s*=>)|\([\s\S]*?\)\s*(?:=>)?)/);
                entry.signature = sigMatch?.[0]?.slice(0, 120) ?? fnStr.slice(0, 60);
                entry.preview = fnStr.slice(0, 120);
            } else if (type === "object" && val) entry.preview = Object.keys(val).slice(0, 10).join(", ");
            else if (type === "string") entry.preview = String(val).slice(0, 50);
            exports[key] = entry;
        }

        const patchedBy = u.getModulePatchedBy(id);
        const isObj = typeof exp === "object" && exp !== null;
        return { found: true, id, hint: u.getModuleHint(id), patchedBy: patchedBy.length ? patchedBy : undefined, hasDefault: isObj && "default" in exp, exportCount: Object.keys(exp).length, exports };
    }

    if (action === "context") {
        if (!id) return u.missingArg("id");
        if (!pattern) return u.missingArg("pattern");
        const chars = args.chars ?? LIMITS.MODULE.CONTEXT_DEFAULT_CHARS;
        const source = u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);

        const matcher = u.makePatternMatcher(pattern);
        const matchIdx = matcher.firstIndex(source);
        if (matchIdx < 0) return { found: false, pattern, message: "Pattern not found in module" };
        const matchedLen = matcher.matchLen(source);

        const start = Math.max(0, matchIdx - chars);
        const end = Math.min(source.length, matchIdx + matchedLen + chars);
        let context = source.slice(start, end);
        const intlAnnotations: Array<{ hash: string; key: string }> = [];
        context = context.replace(createIntlHashDotRegex(), (full, hash: string) => {
            const key = u.getIntlKeyFromHash(hash);
            if (key) { intlAnnotations.push({ hash, key }); return `.t./*${key}*/`; }
            return full;
        });
        return { found: true, moduleId: id, hint: u.getModuleHint(id), matchIndex: matchIdx, matchLength: matchedLen, context, matchedText: source.slice(matchIdx, matchIdx + matchedLen), intlAnnotations: intlAnnotations.length ? intlAnnotations : undefined };
    }

    if (action === "diff") {
        if (!id) return u.missingArg("id");
        const original = u.getModuleSource(id);
        if (!original) return u.moduleNotFound(id);

        const patchedBy = u.getModulePatchedBy(id);
        if (!patchedBy.length) return { id, patched: false };

        const patched = u.extractModule(id, true);
        const patchedClean = patched.startsWith("//") ? patched.slice(patched.indexOf("\n") + 1) : patched;

        const pad = LIMITS.MODULE.DIFF_CONTEXT_PAD;
        const maxRegionLen = LIMITS.MODULE.DIFF_MAX_REGION_LEN;
        const changes: Array<{ offset: number; original: string; patched: string }> = [];

        let oi = 0, pi = 0;
        while (oi < original.length && pi < patchedClean.length) {
            if (original[oi] === patchedClean[pi]) {
                oi++;
                pi++;
                continue;
            }

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
                    while (match < LIMITS.MODULE.DIFF_RESYNC_MATCH && oPos + match < original.length && pPos + match < patchedClean.length && original[oPos + match] === patchedClean[pPos + match])
                        match++;
                    if (match >= LIMITS.MODULE.DIFF_RESYNC_MATCH) {
                        bestOEnd = oPos;
                        bestPEnd = pPos;
                        break;
                    }
                }
            }

            if (bestOEnd < 0) {
                changes.push({
                    offset: changeStart,
                    original: original.slice(Math.max(0, changeStart - pad), original.length).slice(0, maxRegionLen),
                    patched: patchedClean.slice(Math.max(0, pChangeStart - pad), patchedClean.length).slice(0, maxRegionLen),
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

        const changesTruncated = changes.length >= LIMITS.MODULE.DIFF_MAX_REGIONS;
        return { found: true, id, hasPatches: true, patchedBy, originalSize: original.length, patchedSize: patchedClean.length, changeCount: changes.length, truncated: changesTruncated ? true : undefined, note: changesTruncated ? `Showing the first ${LIMITS.MODULE.DIFF_MAX_REGIONS} change regions, there may be more later in the module` : undefined, changes };
    }

    if (props?.length) {
        const filter = filters.byProps(...props);
        const mods = findModuleMatches(filter, args.all ? limit : 1);
        if (!mods.length) return { found: false, message: "No module found with those props" };

        if (args.all) {
            return {
                count: mods.length,
                filterType: "props",
                modules: mods.map((m, i) => ({
                    ...moduleMatchBase(m, i),
                    keys: u.exportKeysPreview(m.exports),
                    sample:
                        typeof m.exports === "object" && m.exports
                            ? u.typeSample(m.exports as Record<string, unknown>, 10)
                            : typeof m.exports === "function"
                              ? m.exports.toString().slice(0, LIMITS.MODULE.EXPORT_SOURCE_SNIPPET)
                              : String(m.exports),
                })),
            };
        }
        const m = mods[0];
        const mod = m.exports as Record<string, unknown>;
        return {
            found: true,
            moduleId: m.id,
            hint: u.getModuleHint(m.id),
            exportKey: m.key,
            keys: Object.keys(mod),
            sample: u.typeSample(mod, 20),
        };
    }

    if (code?.length) {
        const filter = filters.componentByCode(...code);
        const mods = findModuleMatches(filter, args.all ? limit : 1);
        if (!mods.length) return { found: false, message: "No module found with that code" };

        if (args.all) {
            return {
                count: mods.length,
                filterType: "code",
                modules: mods.map((m, i) => ({
                    ...moduleMatchBase(m, i),
                    source: typeof m.exports === "function" ? m.exports.toString().slice(0, LIMITS.MODULE.EXPORT_SOURCE_SNIPPET) : undefined,
                    keys: u.exportKeysPreview(m.exports),
                })),
            };
        }
        const m = mods[0];
        const hint = u.getModuleHint(m.id);
        if (typeof m.exports === "function") return { found: true, moduleId: m.id, hint, exportKey: m.key, type: "function", source: m.exports.toString().slice(0, LIMITS.MODULE.EXPORT_SOURCE_PREVIEW) };
        return { found: true, moduleId: m.id, hint, exportKey: m.key, type: typeof m.exports, keys: Object.keys(m.exports as object) };
    }

    if (displayName) {
        const exact = args.exact ?? false;
        const lower = displayName.toLowerCase();
        const matches: Array<{ moduleId: string; exportKey: string; displayName: string; type: string; keys?: string[] }> = [];

        for (const [modId, mod] of u.moduleEntries()) {
            if (matches.length >= limit) break;
            if (!mod?.exports) continue;
            const exp = mod.exports;

            const checkExport = (val: WebpackExport | null | undefined, key: string) => {
                if (!val) return;
                const dn = val.displayName ?? val.name;
                if (typeof dn !== "string") return;
                const isMatch = exact ? dn === displayName || dn.toLowerCase() === lower : dn.toLowerCase().includes(lower);
                if (isMatch) {
                    matches.push({
                        moduleId: modId,
                        exportKey: key,
                        displayName: dn,
                        type: typeof val === "function" ? u.classifyExportType(val) : "Object",
                        keys: typeof val === "object" ? Object.keys(val).slice(0, 15) : undefined,
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

    if (action === "css") {
        if (className) {
            const { index, modules } = u.getCSSIndex();
            const lower = className.toLowerCase();
            const matches: Array<{ moduleId: string; hash: string; classCount: number; matchingClasses: Record<string, string> }> = [];

            for (const [modId, info] of modules) {
                const matching = Object.fromEntries(Object.entries(info.classes).filter(([k, v]) => v.toLowerCase().includes(lower) || k.toLowerCase().includes(lower)));
                if (Object.keys(matching).length) {
                    matches.push({ moduleId: modId, hash: info.hash, classCount: info.classCount, matchingClasses: matching });
                    if (matches.length >= limit) break;
                }
            }

            return { totalIndexed: index.size, count: matches.length, matches };
        }

        return u.getCSSModuleStats();
    }

    if (className) {
        if (u.isRenderedClassName(className)) {
            const { index, modules } = u.getCSSIndex();
            const entry = index.get(className);
            if (entry) {
                const modInfo = modules.get(entry.moduleId);
                const allClasses = modInfo ? Object.fromEntries(Object.entries(modInfo.classes).slice(0, LIMITS.CSS.MAX_CLASSES_PER_MODULE)) : {};
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
        const classMatch = ([k, v]: [string, unknown]) => typeof v === "string" && (k.toLowerCase().includes(lower) || v.toLowerCase().includes(lower));
        const mods = findModuleMatches(m => !!m && typeof m === "object" && Object.entries(m).some(classMatch), limit);
        const matches = mods.map(m => ({ moduleId: m.id, classes: Object.fromEntries(Object.entries(m.exports as Record<string, string>).filter(classMatch).slice(0, 10)) }));

        return { count: mods.length, matches };
    }

    if (exportName) {
        const matches: Array<{ moduleId: string; exportKey: string; type: string; displayName?: string; source?: string }> = [];

        const common = getCommonModules();
        const commonValue = common[exportName] as WebpackExport | undefined;
        let commonModuleId: string | undefined;

        if (commonValue) {
            for (const [modId, mod] of u.moduleEntries()) {
                const exp = mod?.exports;
                if (!exp) continue;
                const exportKey = exp === commonValue ? "module.exports" : exp.default === commonValue ? "default" : Object.keys(exp).find(k => exp[k] === commonValue);
                if (exportKey === undefined) continue;
                commonModuleId = modId;
                matches.push({
                    moduleId: modId,
                    exportKey,
                    type: u.classifyExportType(commonValue),
                    displayName: commonValue.displayName ?? commonValue.name,
                    source: "Webpack.Common",
                });
                break;
            }
        }

        for (const [modId, mod] of u.moduleEntries()) {
            if (matches.length >= limit) break;
            if (modId === commonModuleId || !mod?.exports) continue;
            const exp = mod.exports;

            const checkExport = (val: WebpackExport | null | undefined, key: string) => {
                if (!val) return;
                const nm = val.displayName ?? val.name;
                if (nm === exportName || key === exportName) {
                    matches.push({
                        moduleId: modId,
                        exportKey: key,
                        type: u.classifyExportType(val),
                        displayName: nm,
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
            tip: matches.length ? (commonValue ? `Webpack.Common.${exportName}` : undefined) : commonValue ? "In Webpack.Common but module ID unresolved" : `No export "${exportName}" found`,
        };
    }

    if (exportValue) {
        const filter = (m: unknown): boolean => !!m && typeof m === "object" && Object.values(m).includes(exportValue);
        const mods = findModuleMatches(filter, limit);
        const matches = mods.map(m => {
            const obj = m.exports as Record<string, unknown>;
            const keys = Object.keys(obj);
            return { moduleId: m.id, hint: u.getModuleHint(m.id), keys: keys.slice(0, 20), matchingKeys: keys.filter(k => obj[k] === exportValue) };
        });

        return { value: exportValue, valueType: typeof exportValue, count: mods.length, matches };
    }

    if (action === "annotate") {
        if (!id) return u.missingArg("id");
        let source = args.patched !== false ? u.extractModule(id, true) : u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);

        const annotations: Array<{ hash: string; key: string }> = [];
        for (const regex of [createIntlHashDotRegex(), createIntlHashBracketRegex()]) {
            source = source.replace(regex, (match, hash: string) => {
                const key = u.getIntlKeyFromHash(hash);
                if (!key) return match;
                annotations.push({ hash, key });
                return match.endsWith("]") ? `${match.slice(0, -1)}/*${key}*/]` : `${match}/*${key}*/`;
            });
        }

        const maxLen = Math.min(maxLength, CONTEXT.ANNOTATE_MAX_LENGTH);
        const patchedBy = u.getModulePatchedBy(id);
        return {
            id,
            usedPatchedSource: args.patched !== false,
            patched: patchedBy.length > 0,
            patchedBy,
            annotationCount: annotations.length,
            size: source.length,
            truncated: source.length > maxLen,
            source: source.slice(0, maxLen),
        };
    }

    if (action === "genFinds") return handleGenFinds(args);

    if (action === "fingerprint") {
        if (!id) return u.missingArg("id");
        const source = u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);
        const fp = fingerprintModule(source);
        return { id, ...fp, note: "Build-stable landmark fingerprint (intl keys, store names, error strings, css hashes) for cross-build module identity" };
    }

    if (action === "suggest") {
        if (!id) return u.missingArg("id");
        const source = u.getModuleSource(id);
        if (!source) return u.moduleNotFound(id);

        const MAX_SUGGEST_CANDIDATES = 250;
        const candidates: SuggestCandidate[] = [];
        const seen = new Set<string>();

        const addCandidate = (find: string, searchStr: string, type: string, intlKey?: string) => {
            if (candidates.length >= MAX_SUGGEST_CANDIDATES) return;
            if (seen.has(find) || find.length < LIMITS.MODULE.SUGGEST_MIN_FIND_LEN) return;
            seen.add(find);
            const count = u.countModuleMatches(searchStr, 3);
            candidates.push({ find, type, unique: count === 1, moduleCount: count, intlKey });
        };

        const rawAnchors: AnchorCandidate[] = [];

        for (const { hash, key, index } of u.iterIntlHashes(source)) {
            const findStr = u.intlFind(hash, key);
            const searchStr = canonicalizeMatch(findStr);
            addCandidate(findStr, searchStr, "intl", key ?? undefined);
            rawAnchors.push({ find: findStr, search: searchStr, type: "intl", index });
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
            { regex: IDENT_ASSIGN_RE(), extract: m => (NOISE_STRINGS.has(m[1]) || /^[a-z]{1,2}$/.test(m[1]) ? null : { find: m[1], search: m[1], type: "ident" }) },
        ];

        for (const { regex, extract } of anchorScans) {
            for (const anchor of u.scanSingleOccurrences(source, regex, extract)) {
                addCandidate(anchor.find, anchor.search, anchor.type);
                rawAnchors.push(anchor);
            }
        }

        const ctxSuffixes = [";", ")", ",", "}", '"'];
        const ctxPrefixes = ["=", "(", ",", "{", '"'];

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

        if (!candidates.some(c => c.unique) && rawAnchors.length >= 2) {
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

        candidates.sort((a, b) => u.compareByAnchorType(a, b, ANCHOR_TYPE_ORDER));

        const topN = LIMITS.MODULE.SUGGEST_TOP_N;
        const typeBuckets = new Map<string, SuggestCandidate[]>();
        for (const c of candidates) {
            const base = c.type.replace("+ctx", "");
            const bucket = typeBuckets.get(base);
            if (bucket) bucket.push(c);
            else typeBuckets.set(base, [c]);
        }
        const result = [...typeBuckets.values()].flatMap(bucket => {
            const pick = bucket.filter(c => c.unique).slice(0, 3);
            return pick.length ? pick : bucket.slice(0, 2);
        });
        if (result.length < topN) {
            for (const c of candidates) {
                if (result.length >= topN) break;
                if (!result.includes(c)) result.push(c);
            }
        }
        result.sort((a, b) => u.compareByAnchorType(a, b, ANCHOR_TYPE_ORDER));

        return { id, sourceSize: source.length, candidateCount: candidates.length, suggestions: result.slice(0, topN) };
    }

    if (pattern || action === "find") {
        if (!pattern) return u.missingArg("pattern");
        const matcher = u.makePatternMatcher(pattern);
        const results = u.findModuleIds(matcher.test, limit);

        return {
            count: results.length,
            ids: results,
            preview: results.map(moduleId => {
                const source = u.getModuleSource(moduleId);
                const idx = matcher.firstIndex(source);
                return { id: moduleId, hint: u.getModuleHint(moduleId), snippet: u.snippet(source, idx, matcher.matchLen(source), CONTEXT.SEARCH_SNIPPET, CONTEXT.SEARCH_SNIPPET + 100) };
            }),
        };
    }

    return { error: true, message: "Specify action or search criteria" };
}
