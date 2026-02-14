/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { FinderResult, FinderSpec, PatchToolArgs, VencordPlugin } from "../types";
import { filters, findAll, findStore, plugins } from "../webpack";
import { createIntlKeyPatternRegex, FORBIDDEN_PATCH_PATTERNS, MINIFIED_VARS_PATTERN } from "./constants";
import {
    batchCountModuleMatches,
    getModuleSource,
    intlHashExistsInDefinitions,
    parseRegex,
    runtimeHashMessageKey,
    searchModulesOptimized,
} from "./utils";

const intlKeyPattern = createIntlKeyPatternRegex();

export async function handlePatchTool(args: PatchToolArgs): Promise<unknown> {
    const { action, find: findStr, str, pluginName } = args;

    if (action === "unique" || (str && !action)) {
        const searchStr = str ?? findStr;
        if (!searchStr) return { error: true, message: "str or find required" };

        const canonSearch = canonicalizeMatch(searchStr);
        const moduleIds = searchModulesOptimized(source => source.includes(canonSearch), 11);
        const count = moduleIds.length;

        return {
            str: searchStr,
            count,
            unique: count === 1,
            moduleIds: moduleIds.slice(0, 10),
            valid: count === 1 ? "Unique" : count === 0 ? "No matches" : `${count} modules, not unique`
        };
    }

    if (action === "plugin") {
        if (!pluginName) return { error: true, message: "pluginName required" };

        const plugin = plugins[pluginName] as VencordPlugin | undefined;

        if (!plugin) {
            const similar = Object.keys(plugins).filter(n => n.toLowerCase().includes(pluginName.toLowerCase())).slice(0, 5);
            return { error: true, message: `Plugin "${pluginName}" not found`, suggestions: similar.length ? similar : undefined };
        }

        if (!plugin.patches?.length) {
            return { name: pluginName, enabled: plugin.started ?? false, patchCount: 0 };
        }

        let ok = 0, broken = 0, ambiguous = 0;

        const patchDetails = plugin.patches.map((patch, index) => {
            const rawFind = typeof patch.find === "string" ? patch.find : patch.find?.toString() ?? "";
            const canonFind = canonicalizeMatch(rawFind);
            const matchingModules = searchModulesOptimized(src => src.includes(canonFind), 5);
            const moduleCount = matchingModules.length;

            const status = moduleCount === 0 ? "NO_MATCH" : moduleCount === 1 ? "OK" : "MULTIPLE_MATCH";
            if (status === "OK") ok++;
            else if (status === "NO_MATCH") broken++;
            else ambiguous++;

            const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
            const replacementInfo = replacements.map(r => ({
                match: r.match?.toString().slice(0, 150),
                replace: typeof r.replace === "string" ? r.replace.slice(0, 100) : "[function]"
            }));

            const info: Record<string, unknown> = { index, find: rawFind.slice(0, 200), status, moduleCount, replacements: replacementInfo };
            if (status === "OK") info.moduleId = matchingModules[0];
            if (status === "MULTIPLE_MATCH") info.moduleIds = matchingModules.slice(0, 5);

            if (status !== "OK" && rawFind.includes("#{intl::")) {
                if (canonFind !== rawFind) info.canonicalizedFind = canonFind.slice(0, 100);
                const intlMatch = rawFind.match(intlKeyPattern);
                if (intlMatch?.[1]) {
                    info.intlKey = intlMatch[1];
                    const hash = runtimeHashMessageKey(intlMatch[1]);
                    const exists = intlHashExistsInDefinitions(hash);
                    info.intlStatus = exists ? "key_valid_but_unused" : "key_not_found";
                }
            }

            return info;
        });

        return {
            found: true,
            name: pluginName,
            enabled: plugin.started ?? false,
            patchCount: plugin.patches.length,
            summary: { ok, broken, ambiguous },
            health: broken === 0 ? "HEALTHY" : broken < plugin.patches.length / 2 ? "DEGRADED" : "BROKEN",
            patches: patchDetails
        };
    }

    if (action === "analyze") {
        const pluginFilter = pluginName;
        const showNoMatch = args.showNoMatch ?? true;
        const showMultiMatch = args.showMultiMatch ?? true;
        const showValid = args.showValid ?? false;

        const issues: Array<{
            plugin: string;
            enabled?: boolean;
            patchIndex: number;
            find: string;
            canonicalizedFind?: string;
            issue: string;
            severity: string;
            moduleCount?: number;
            details?: string;
            intlKey?: string;
            intlStatus?: string;
        }> = [];

        const stats = { totalPlugins: 0, totalPatches: 0, noMatch: 0, multiMatch: 0, slowPatches: 0, validPatches: 0 };
        const patchInfos: Array<{ plugin: string; enabled: boolean; patchIndex: number; rawFind: string; canonFind: string; intlKey?: string }> = [];

        for (const [nm, plugin] of Object.entries(plugins) as [string, VencordPlugin][]) {
            if (pluginFilter && !nm.toLowerCase().includes(pluginFilter.toLowerCase())) continue;
            if (!plugin.patches?.length) continue;

            stats.totalPlugins++;
            const enabled = plugin.started ?? false;
            for (let i = 0; i < plugin.patches.length; i++) {
                const patch = plugin.patches[i];
                stats.totalPatches++;

                const rawFind = typeof patch.find === "string" ? patch.find : patch.find?.toString() ?? "";
                const intlMatch = rawFind.match(intlKeyPattern);
                patchInfos.push({ plugin: nm, enabled, patchIndex: i, rawFind, canonFind: canonicalizeMatch(rawFind), intlKey: intlMatch?.[1] });
            }
        }

        const uniqueFinds = [...new Set(patchInfos.map(p => p.canonFind))];
        const batchResults = batchCountModuleMatches(uniqueFinds, 11);

        for (const { plugin: nm, enabled, patchIndex: i, rawFind, canonFind, intlKey } of patchInfos) {
            const { count: moduleCount } = batchResults.get(canonFind) ?? { count: 0 };
            const usesIntl = rawFind.includes("#{intl::");
            const displayFind = usesIntl ? rawFind.slice(0, 100) : canonFind.slice(0, 100);

            if (moduleCount === 0) {
                stats.noMatch++;
                if (showNoMatch) {
                    const issue: typeof issues[0] = { plugin: nm, enabled: enabled ? true : undefined, patchIndex: i, find: displayFind, issue: "NO_MATCH", severity: "error", moduleCount: 0, details: "Find matches no modules" };

                    if (usesIntl && canonFind !== rawFind) {
                        issue.canonicalizedFind = canonFind.slice(0, 100);
                        if (intlKey) {
                            issue.intlKey = intlKey;
                            const hash = runtimeHashMessageKey(intlKey);
                            const exists = intlHashExistsInDefinitions(hash);
                            issue.intlStatus = exists ? "key_valid_but_unused" : "key_not_found";
                            issue.details = exists ? "Intl key valid but unused in Discord code" : "Intl key not in definitions";
                        }
                    }
                    issues.push(issue);
                }
            } else if (moduleCount > 1) {
                stats.multiMatch++;
                if (showMultiMatch) {
                    const issue: typeof issues[0] = { plugin: nm, enabled: enabled ? true : undefined, patchIndex: i, find: displayFind, issue: "MULTIPLE_MATCH", severity: "warning", moduleCount, details: `Matches ${moduleCount}+ modules` };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, 100);
                    issues.push(issue);
                }
            } else {
                stats.validPatches++;
                if (showValid) {
                    const issue: typeof issues[0] = { plugin: nm, enabled: enabled ? true : undefined, patchIndex: i, find: displayFind, issue: "OK", severity: "info", moduleCount: 1 };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, 100);
                    issues.push(issue);
                }
            }
        }

        return { stats, issueCount: stats.noMatch + stats.multiMatch, issues: issues.slice(0, 100) };
    }

    if (action === "lint") {
        if (!findStr) return { error: true, message: "find required" };

        const matchPattern = args.match;

        const analyzePattern = (pattern: string, isFind: boolean) => {
            const warnings: string[] = [];
            const errors: string[] = [];
            const anchors: string[] = [];
            let score = 5;

            if (pattern.includes("#{intl::")) { anchors.push("intl"); score += 3; }
            if (/"[^"]{3,}"/.test(pattern) || /'[^']{3,}'/.test(pattern)) { anchors.push("string-literal"); score += 2; }
            if (/[A-Za-z_$][\w$]*:/.test(pattern)) { anchors.push("prop-name"); score += 2; }
            if (pattern.includes("\\i")) { anchors.push("identifier"); score += 1; }
            if (/\(\?<=/.test(pattern)) { anchors.push("lookbehind"); score += 1; }

            const minifiedMatches = pattern.match(MINIFIED_VARS_PATTERN);
            if (minifiedMatches && !pattern.includes("\\i")) {
                errors.push(`Hardcoded minified vars: ${[...new Set(minifiedMatches)].join(", ")}`);
                score -= 3;
            }

            for (const forbidden of FORBIDDEN_PATCH_PATTERNS) {
                if (forbidden.test(pattern)) {
                    errors.push(`Forbidden pattern: ${forbidden.source}`);
                    score -= 2;
                }
            }

            if (isFind && pattern.length < 20 && !pattern.includes("#{intl::")) {
                warnings.push("Find < 20 chars, may not be unique");
                score -= 1;
            }

            if (/\b(function|return|if|for|while|const|let)\b/.test(pattern) && !pattern.includes("\\i")) {
                warnings.push("Anchored on generic keywords");
                score -= 2;
            }

            if (/\.\+\??|\.\*\??/.test(pattern) && !/\.\{/.test(pattern)) {
                warnings.push("Unbounded wildcards, use .{0,N}");
                score -= 1;
            }

            if (pattern.length > 200) { warnings.push("> 200 chars, shorten"); score -= 1; }

            let captures = 0;
            for (let i = 0; i < pattern.length - 1; i++) {
                if (pattern[i] === "(" && pattern[i + 1] !== "?") captures++;
            }
            if (captures > 3) { warnings.push(`${captures} captures, max 3`); score -= 1; }
            if (!anchors.length) { warnings.push("No strong anchors detected"); score -= 1; }

            return { score: Math.max(1, Math.min(10, score)), anchors, warnings, errors };
        };

        const findAnalysis = analyzePattern(findStr, true);
        const matchAnalysis = matchPattern ? analyzePattern(matchPattern, false) : null;
        const canonFind = canonicalizeMatch(findStr);
        const moduleIds = searchModulesOptimized(src => src.includes(canonFind), 5);
        const allErrors = [...findAnalysis.errors, ...(matchAnalysis?.errors ?? [])];
        const allWarnings = [...findAnalysis.warnings, ...(matchAnalysis?.warnings ?? [])];

        if (moduleIds.length === 0) {
            allErrors.push("Find matches no modules");
            findAnalysis.score = Math.max(1, findAnalysis.score - 5);
        } else if (moduleIds.length > 1) {
            allWarnings.push(`Find matches ${moduleIds.length} modules`);
            findAnalysis.score = Math.max(1, findAnalysis.score - 3);
        }

        const overallScore = matchAnalysis ? Math.round((findAnalysis.score + matchAnalysis.score) / 2) : findAnalysis.score;

        return {
            find: { pattern: findStr.slice(0, 200), ...findAnalysis, unique: moduleIds.length === 1, moduleCount: moduleIds.length },
            match: matchAnalysis ? { pattern: matchPattern!.slice(0, 200), ...matchAnalysis } : undefined,
            overallScore,
            verdict: allErrors.length ? "BROKEN" : overallScore >= 7 ? "GOOD" : overallScore >= 4 ? "ACCEPTABLE" : "NEEDS_WORK",
            allWarnings: allWarnings.length ? allWarnings : undefined,
            allErrors: allErrors.length ? allErrors : undefined
        };
    }

    if (action === "finds") {
        const specs = args.finders;
        if (!specs?.length) return { error: true, message: "finders array required" };

        const results: FinderResult[] = [];
        let found = 0, broken = 0;

        for (const spec of specs.slice(0, 100)) {
            const result = validateFinder(spec);
            results.push(result);
            if (result.found) found++;
            else broken++;
        }

        return {
            total: results.length,
            found,
            broken,
            health: broken === 0 ? "HEALTHY" : broken < results.length / 2 ? "DEGRADED" : "BROKEN",
            results: results.filter(r => !r.found || args.showValid).slice(0, 100),
            allResults: args.showValid ? undefined : `${found} valid finders hidden, use showValid to include`
        };
    }

    if (action === "benchmark") {
        if (!pluginName) return { error: true, message: "pluginName required" };

        const plugin = plugins[pluginName] as VencordPlugin | undefined;
        if (!plugin) return { error: true, message: `Plugin "${pluginName}" not found` };
        if (!plugin.patches?.length) return { name: pluginName, patchCount: 0, message: "No patches" };

        const iters = Math.min(Math.max(args.iterations ?? 10000, 100), 100000);
        const numRounds = Math.min(Math.max(args.rounds ?? 3, 1), 10);
        const results: Array<Record<string, unknown>> = [];

        for (const [patchIdx, patch] of plugin.patches.entries()) {
            const rawFind = typeof patch.find === "string" ? patch.find : patch.find?.toString() ?? "";
            const canonFind = canonicalizeMatch(rawFind);
            const moduleId = searchModulesOptimized(src => src.includes(canonFind), 2)[0];
            if (!moduleId) {
                results.push({ patchIndex: patchIdx, find: rawFind.slice(0, 80), error: "Module not found" });
                continue;
            }

            const source = getModuleSource(moduleId);
            const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];

            for (const [repIdx, rep] of replacements.entries()) {
                if (!rep.match) continue;
                const regex = typeof rep.match === "string" ? new RegExp(canonicalizeMatch(rep.match)) : canonicalizeMatch(rep.match);
                const replaceStr = typeof rep.replace === "string" ? rep.replace : "$&";

                const coldStart = performance.now();
                source.replace(regex, replaceStr);
                const coldMs = performance.now() - coldStart;

                for (let i = 0; i < Math.min(iters, 500); i++) source.replace(regex, replaceStr);

                const roundTimes: number[] = [];
                for (let r = 0; r < numRounds; r++) {
                    const start = performance.now();
                    for (let i = 0; i < iters; i++) source.replace(regex, replaceStr);
                    roundTimes.push(performance.now() - start);
                }

                const perOp = roundTimes.map(t => t / iters);
                const median = [...perOp].sort((a, b) => a - b)[Math.floor(perOp.length / 2)];

                results.push({
                    patchIndex: patchIdx,
                    replacementIndex: repIdx,
                    moduleId,
                    moduleSize: source.length,
                    match: String(rep.match).slice(0, 80),
                    coldMs: +coldMs.toFixed(3),
                    wouldFlagSlow: coldMs > 5,
                    medianUs: +(median * 1000).toFixed(2),
                    roundsUs: perOp.map(t => +(t * 1000).toFixed(2)),
                });
            }
        }

        const slowCount = results.filter(r => (r as { wouldFlagSlow?: boolean }).wouldFlagSlow).length;
        return { plugin: pluginName, iterations: iters, rounds: numRounds, slowCount, results };
    }

    if (action === "compare") {
        if (!findStr) return { error: true, message: "find required" };
        if (!args.matchA || !args.matchB) return { error: true, message: "matchA and matchB required" };

        const canonFind = canonicalizeMatch(findStr);
        const moduleId = searchModulesOptimized(src => src.includes(canonFind), 2)[0];
        if (!moduleId) return { error: true, message: "Find matches no module" };

        const source = getModuleSource(moduleId);
        const iters = Math.min(Math.max(args.iterations ?? 10000, 100), 100000);
        const numRounds = Math.min(Math.max(args.rounds ?? 5, 1), 10);

        const buildRegex = (pattern: string): RegExp => {
            const parsed = parseRegex(pattern);
            return canonicalizeMatch(parsed ?? new RegExp(pattern));
        };

        const benchOne = (label: string, matchStr: string, replaceStr: string) => {
            let regex: RegExp;
            try { regex = buildRegex(matchStr); }
            catch { return { label, error: "Invalid regex" }; }

            const matchResult = source.match(regex);
            if (!matchResult) return { label, error: "Match failed", match: matchStr };

            const coldStart = performance.now();
            source.replace(regex, replaceStr);
            const coldMs = performance.now() - coldStart;

            for (let i = 0; i < Math.min(iters, 500); i++) source.replace(regex, replaceStr);

            const roundTimes: number[] = [];
            for (let r = 0; r < numRounds; r++) {
                const start = performance.now();
                for (let i = 0; i < iters; i++) source.replace(regex, replaceStr);
                roundTimes.push(performance.now() - start);
            }

            const perOp = roundTimes.map(t => t / iters);
            const median = [...perOp].sort((a, b) => a - b)[Math.floor(perOp.length / 2)];

            return {
                label,
                match: matchStr.slice(0, 100),
                replace: replaceStr.slice(0, 100),
                matched: matchResult[0].slice(0, 80),
                coldMs: +coldMs.toFixed(3),
                medianUs: +(median * 1000).toFixed(2),
                roundsUs: perOp.map(t => +(t * 1000).toFixed(2)),
            };
        };

        const a = benchOne("A", args.matchA, args.replaceA ?? "$&");
        const b = benchOne("B", args.matchB, args.replaceB ?? "$&");

        const aMedian = (a as { medianUs?: number }).medianUs;
        const bMedian = (b as { medianUs?: number }).medianUs;
        let winner: string | undefined;
        let speedup: string | undefined;
        if (aMedian != null && bMedian != null) {
            winner = aMedian <= bMedian ? "A" : "B";
            const ratio = Math.max(aMedian, bMedian) / Math.min(aMedian, bMedian);
            speedup = ratio.toFixed(2) + "x";
        }

        return { find: findStr, moduleId, moduleSize: source.length, iterations: iters, rounds: numRounds, a, b, winner, speedup };
    }

    return { error: true, message: "action: unique, plugin, analyze, lint, finds, benchmark, compare" };
}

function validateFinder(spec: FinderSpec): FinderResult {
    const { type, args, plugin } = spec;
    if (!args?.length) return { type, args: args ?? [], plugin, found: false, error: "No args provided" };

    try {
        switch (type) {
            case "byProps": {
                const res = findAll(filters.byProps(...args));
                if (!res.length) return { type, args, plugin, found: false, error: "No module exports these props" };
                return { type, args, plugin, found: true, exportType: typeof res[0] };
            }
            case "byCode": {
                const parsed = args.map(canonicalizeMatch);
                const res = findAll(filters.byCode(...parsed));
                if (!res.length) return { type, args, plugin, found: false, error: "No module contains this code" };
                return { type, args, plugin, found: true, exportType: typeof res[0] };
            }
            case "store": {
                try {
                    const store = findStore(args[0]);
                    return { type, args, plugin, found: store != null };
                } catch {
                    return { type, args, plugin, found: false, error: `Store "${args[0]}" not found` };
                }
            }
            case "componentByCode": {
                const parsed = args.map(canonicalizeMatch);
                const res = findAll(filters.componentByCode(...parsed));
                if (!res.length) return { type, args, plugin, found: false, error: "No component contains this code" };
                return { type, args, plugin, found: true, exportType: "component" };
            }
            case "exportedComponent": {
                const res = findAll(filters.byProps(...args));
                if (!res.length) return { type, args, plugin, found: false, error: "No module exports this component" };
                const exported = res[0]?.[args[0]];
                if (!exported) return { type, args, plugin, found: false, error: `Prop "${args[0]}" exists but is nullish` };
                return { type, args, plugin, found: true, exportType: typeof exported };
            }
            case "cssClasses":
            case "byClassNames": {
                const res = findAll(filters.byClassNames(...args), { topLevelOnly: true });
                if (!res.length) return { type, args, plugin, found: false, error: "No CSS module has these class names" };
                return { type, args, plugin, found: true, exportType: "cssModule" };
            }
            default:
                return { type, args, plugin, found: false, error: `Unknown finder type "${type}"` };
        }
    } catch (e) {
        return { type, args, plugin, found: false, error: e instanceof Error ? e.message.slice(0, 150) : String(e) };
    }
}
