/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { FinderResult, FinderSpec, PatchToolArgs, PluginPatch, PluginReplacement } from "../types";
import { filters, findAll, findStore, plugins } from "../webpack";
import { FORBIDDEN_PATCH_PATTERNS, LIMITS, MINIFIED_VARS_PATTERN } from "./constants";
import * as u from "./utils";

const P = LIMITS.PATCH;
const A = LIMITS.ANALYSIS;

interface ReplacementAnalysis {
    match?: string;
    replace: string;
    captureCount?: number;
    unusedCaptures?: number[];
    invalidBackrefs?: number[];
    matchFound?: boolean;
    matchedModules?: number;
    totalCandidates?: number;
    syntaxValid?: boolean;
    syntaxError?: string;
    ambiguousMatches?: Array<{ moduleId: string; matched: boolean; syntaxValid?: boolean; syntaxError?: string }>;
    flags?: { noWarn?: boolean; fromBuild?: number; toBuild?: number };
    suppressedBy?: string;
}

function verifyReplacement(matchRegex: RegExp, replace: PluginReplacement["replace"], source: string): { matched: boolean; syntaxValid?: boolean; syntaxError?: string } {
    const matched = matchRegex.test(source);
    if (!matched || typeof replace !== "string") return { matched };
    try {
        const patched = source.replace(matchRegex, replace);
        try {
            new Function(patched);
            return { matched: true, syntaxValid: true };
        } catch (e) {
            return { matched: true, syntaxValid: false, syntaxError: e instanceof Error ? e.message.slice(0, 200) : String(e) };
        }
    } catch (e) {
        return { matched: true, syntaxValid: false, syntaxError: `Replace threw: ${e instanceof Error ? e.message : String(e)}` };
    }
}

function analyzeReplacement(r: PluginReplacement, modules: Array<{ id: string; source: string }>, parent?: PluginPatch): ReplacementAnalysis {
    const out: ReplacementAnalysis = {
        match: r.match?.toString().slice(0, P.REPLACEMENT_MATCH_SLICE),
        replace: typeof r.replace === "string" ? r.replace.slice(0, P.REPLACEMENT_REPLACE_SLICE) : "[function]",
    };

    const flags: { noWarn?: boolean; fromBuild?: number; toBuild?: number } = {};
    if (r.noWarn) flags.noWarn = true;
    if (r.fromBuild != null) flags.fromBuild = r.fromBuild;
    if (r.toBuild != null) flags.toBuild = r.toBuild;
    if (Object.keys(flags).length) out.flags = flags;

    if (r.noWarn || parent?.noWarn) out.suppressedBy = r.noWarn ? "replacement.noWarn" : "patch.noWarn";

    if (!r.match) return out;
    const matchRegex = u.safeCall<RegExp | null>(() => u.buildPatchRegex(r.match!), null);
    if (!matchRegex) return out;

    const captureCount = u.countUnescapedCaptures(matchRegex.source);
    out.captureCount = captureCount;

    if (typeof r.replace === "string") {
        const referencedNum = new Set<number>();
        for (const m of r.replace.matchAll(/\$(\d+)/g)) referencedNum.add(parseInt(m[1], 10));
        const referencedNames = new Set<string>();
        for (const m of r.replace.matchAll(/\$<([A-Za-z_$][\w$]*)>/g)) referencedNames.add(m[1]);
        const namedGroups = u.extractCaptureNames(matchRegex.source);
        const numericCount = captureCount - namedGroups.length;

        const unused: number[] = [];
        const invalid: number[] = [];
        const invalidNames: string[] = [];
        for (let i = 1; i <= numericCount; i++) if (!referencedNum.has(i)) unused.push(i);
        for (const ref of referencedNum) if (ref > captureCount || ref < 1) invalid.push(ref);
        for (const n of referencedNames) if (!namedGroups.includes(n)) invalidNames.push(n);
        if (unused.length) out.unusedCaptures = unused;
        if (invalid.length) out.invalidBackrefs = invalid;
        if (invalidNames.length) (out as ReplacementAnalysis & { invalidNamedRefs?: string[] }).invalidNamedRefs = invalidNames;
    }

    if (!modules.length) return out;

    if (modules.length === 1) {
        const { matched, syntaxValid, syntaxError } = verifyReplacement(matchRegex, r.replace, modules[0].source);
        out.matchFound = matched;
        if (syntaxValid !== undefined) out.syntaxValid = syntaxValid;
        if (syntaxError) out.syntaxError = syntaxError;
        return out;
    }

    const per = modules.map(m => ({ moduleId: m.id, ...verifyReplacement(matchRegex, r.replace, m.source) }));
    out.totalCandidates = modules.length;
    out.matchedModules = per.filter(p => p.matched).length;
    out.ambiguousMatches = per;
    return out;
}

export async function handlePatchTool(args: PatchToolArgs): Promise<unknown> {
    const { action, find: findStr, str, pluginName } = args;

    if (action === "unique" || (str && !action)) {
        const searchStr = str ?? findStr;
        if (!searchStr) return { error: true, message: "str or find required" };

        const canonSearch = canonicalizeMatch(searchStr);
        const moduleIds = u.searchModulesOptimized(source => source.includes(canonSearch), P.UNIQUE_EARLY_EXIT);
        const count = moduleIds.length;

        return {
            str: searchStr,
            count,
            unique: count === 1,
            moduleIds: moduleIds.slice(0, P.UNIQUE_MODULE_PREVIEW),
            valid: count === 1 ? "Unique" : count === 0 ? "No matches" : `${count} modules, not unique`,
        };
    }

    if (action === "plugin") {
        if (!pluginName) return u.missingArg("pluginName");

        const plugin = plugins[pluginName];

        if (!plugin) {
            const similar = Object.keys(plugins)
                .filter(n => n.toLowerCase().includes(pluginName.toLowerCase()))
                .slice(0, P.PLUGIN_SIMILAR_SUGGESTIONS);
            return { error: true, message: `Plugin "${pluginName}" not found`, suggestions: similar.length ? similar : undefined };
        }

        if (!plugin.patches?.length) {
            return { name: pluginName, enabled: plugin.started ?? false, patchCount: 0 };
        }

        let ok = 0,
            broken = 0,
            ambiguous = 0;

        const patchDetails = plugin.patches.map((patch, index) => {
            const rawFind = u.patchFindAsString(patch.find);
            const matcher = u.canonFindMatcher(patch.find);
            const canonFind = matcher.canonical;
            const matchingModules = u.searchModulesOptimized(matcher.test, P.PLUGIN_MATCH_EARLY_EXIT);
            const moduleCount = matchingModules.length;

            const expectMultiple = patch.all === true;
            const rawStatus = moduleCount === 0 ? "NO_MATCH" : moduleCount === 1 ? "OK" : "MULTIPLE_MATCH";
            const status = rawStatus === "MULTIPLE_MATCH" && expectMultiple ? "OK_ALL" : rawStatus;

            if (status === "OK" || status === "OK_ALL") ok++;
            else if (status === "NO_MATCH") broken++;
            else ambiguous++;

            const candidateModules = status === "NO_MATCH" ? [] : matchingModules.map(id => ({ id, source: u.getModuleSource(id) }));
            const replacementInfo = u.getReplacements(patch).map(r => analyzeReplacement(r, candidateModules, patch));

            const flags: Record<string, unknown> = {};
            if (patch.all) flags.all = true;
            if (patch.noWarn) flags.noWarn = true;
            if (patch.group) flags.group = true;
            if (patch.fromBuild != null) flags.fromBuild = patch.fromBuild;
            if (patch.toBuild != null) flags.toBuild = patch.toBuild;

            let groupHealth: "OK" | "WOULD_UNDO" | undefined;
            if (patch.group) {
                const anyMissing = replacementInfo.some(r => r.matchFound === false);
                groupHealth = anyMissing ? "WOULD_UNDO" : "OK";
            }

            const info: Record<string, unknown> = { index, find: rawFind.slice(0, P.RAW_FIND_SLICE), status, moduleCount, replacements: replacementInfo };
            if (Object.keys(flags).length) info.flags = flags;
            if (groupHealth) info.groupHealth = groupHealth;
            if (status === "OK") info.moduleId = matchingModules[0];
            if (status === "MULTIPLE_MATCH" || status === "OK_ALL") info.moduleIds = matchingModules.slice(0, P.PLUGIN_MATCH_PREVIEW);

            if (status !== "OK" && status !== "OK_ALL" && rawFind.includes("#{intl::")) {
                if (canonFind !== rawFind) info.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                const probe = u.probeIntlKey(rawFind);
                if (probe) {
                    info.intlKey = probe.intlKey;
                    info.intlStatus = probe.intlStatus;
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
            patches: patchDetails,
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
        const patchInfos: Array<{ plugin: string; enabled: boolean; patchIndex: number; rawFind: string; canonFind: string; matcher: u.CanonFindMatcher; intlKey?: string; all: boolean; noWarn: boolean }> = [];

        for (const [nm, plugin] of Object.entries(plugins)) {
            if (pluginFilter && !nm.toLowerCase().includes(pluginFilter.toLowerCase())) continue;
            if (!plugin.patches?.length) continue;

            stats.totalPlugins++;
            const enabled = plugin.started ?? false;
            for (let i = 0; i < plugin.patches.length; i++) {
                const patch = plugin.patches[i];
                stats.totalPatches++;

                const rawFind = u.patchFindAsString(patch.find);
                const matcher = u.canonFindMatcher(patch.find);
                patchInfos.push({
                    plugin: nm,
                    enabled,
                    patchIndex: i,
                    rawFind,
                    canonFind: matcher.canonical,
                    matcher,
                    intlKey: u.probeIntlKey(rawFind)?.intlKey,
                    all: !!patch.all,
                    noWarn: !!patch.noWarn,
                });
            }
        }

        const stringOnly = patchInfos.filter(p => !p.matcher.isRegex);
        const uniqueFinds = [...new Set(stringOnly.map(p => p.canonFind))];
        const batchResults = u.batchCountModuleMatches(uniqueFinds, P.UNIQUE_EARLY_EXIT);

        for (const { plugin: nm, enabled, patchIndex: i, rawFind, canonFind, matcher, intlKey, all, noWarn } of patchInfos) {
            const moduleCount = matcher.isRegex
                ? u.searchModulesOptimized(matcher.test, P.UNIQUE_EARLY_EXIT).length
                : (batchResults.get(canonFind)?.count ?? 0);
            const usesIntl = rawFind.includes("#{intl::");
            const displayFind = usesIntl ? rawFind.slice(0, P.ANALYZE_FIND_SLICE) : canonFind.slice(0, P.ANALYZE_FIND_SLICE);

            if (moduleCount === 0) {
                if (noWarn) { stats.validPatches++; continue; }
                stats.noMatch++;
                if (showNoMatch) {
                    const issue: (typeof issues)[0] = {
                        plugin: nm,
                        enabled: enabled ? true : undefined,
                        patchIndex: i,
                        find: displayFind,
                        issue: "NO_MATCH",
                        severity: "error",
                        moduleCount: 0,
                        details: "Find matches no modules",
                    };

                    if (usesIntl && canonFind !== rawFind) {
                        issue.canonicalizedFind = canonFind.slice(0, 100);
                        if (intlKey) {
                            const probe = u.probeIntlKey(rawFind);
                            if (probe) {
                                issue.intlKey = probe.intlKey;
                                issue.intlStatus = probe.intlStatus;
                                issue.details = probe.intlStatus === "key_valid_but_unused" ? "Intl key valid but unused in Discord code" : "Intl key not in definitions";
                            }
                        }
                    }
                    issues.push(issue);
                }
            } else if (moduleCount > 1) {
                if (all) { stats.validPatches++; continue; }
                stats.multiMatch++;
                if (showMultiMatch) {
                    const issue: (typeof issues)[0] = {
                        plugin: nm,
                        enabled: enabled ? true : undefined,
                        patchIndex: i,
                        find: displayFind,
                        issue: "MULTIPLE_MATCH",
                        severity: "warning",
                        moduleCount,
                        details: `Matches ${moduleCount}+ modules`,
                    };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                    issues.push(issue);
                }
            } else {
                stats.validPatches++;
                if (showValid) {
                    const issue: (typeof issues)[0] = { plugin: nm, enabled: enabled ? true : undefined, patchIndex: i, find: displayFind, issue: "OK", severity: "info", moduleCount: 1 };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                    issues.push(issue);
                }
            }
        }

        return { stats, issueCount: stats.noMatch + stats.multiMatch, issues: issues.slice(0, P.ANALYZE_MAX_ISSUES) };
    }

    if (action === "lint") {
        if (!findStr) return u.missingArg("find");

        const matchPattern = args.match;

        const analyzePattern = (pattern: string, isFind: boolean) => {
            const warnings: string[] = [];
            const errors: string[] = [];
            const anchors: string[] = [];
            let score = A.BASE_SCORE;

            if (pattern.includes("#{intl::")) {
                anchors.push("intl");
                score += A.SCORE_INTL;
            }
            if (/"[^"]{3,}"/.test(pattern) || /'[^']{3,}'/.test(pattern)) {
                anchors.push("string-literal");
                score += A.SCORE_STRING_LITERAL;
            }
            if (/[A-Za-z_$][\w$]*:/.test(pattern)) {
                anchors.push("prop-name");
                score += A.SCORE_PROP_NAME;
            }
            if (pattern.includes("\\i")) {
                anchors.push("identifier");
                score += A.SCORE_IDENTIFIER;
            }
            if (/\(\?<=/.test(pattern)) {
                anchors.push("lookbehind");
                score += A.SCORE_LOOKBEHIND;
            }

            const minifiedMatches = pattern.match(MINIFIED_VARS_PATTERN);
            if (minifiedMatches && !pattern.includes("\\i")) {
                errors.push(`Hardcoded minified vars: ${[...new Set(minifiedMatches)].join(", ")}`);
                score -= A.SCORE_PENALTY_MINIFIED;
            }

            for (const forbidden of FORBIDDEN_PATCH_PATTERNS) {
                if (forbidden.test(pattern)) {
                    errors.push(`Forbidden pattern: ${forbidden.source}`);
                    score -= A.SCORE_PENALTY_FORBIDDEN;
                }
            }

            if (isFind && pattern.length < P.LINT_MIN_FIND_LENGTH && !pattern.includes("#{intl::")) {
                warnings.push(`Find < ${P.LINT_MIN_FIND_LENGTH} chars, may not be unique`);
                score -= A.SCORE_PENALTY_SHORT;
            }

            if (/\b(function|return|if|for|while|const|let)\b/.test(pattern) && !pattern.includes("\\i")) {
                warnings.push("Anchored on generic keywords");
                score -= A.SCORE_PENALTY_GENERIC;
            }

            if (/\.\+\??|\.\*\??/.test(pattern) && !/\.\{/.test(pattern)) {
                warnings.push("Unbounded wildcards, use .{0,N}");
                score -= A.SCORE_PENALTY_WILDCARD;
            }

            if (pattern.length > P.LINT_MAX_FIND_LENGTH) {
                warnings.push(`> ${P.LINT_MAX_FIND_LENGTH} chars, shorten`);
                score -= A.SCORE_PENALTY_LONG;
            }

            const captures = u.countUnescapedCaptures(pattern);
            if (captures > P.LINT_MAX_CAPTURES) {
                warnings.push(`${captures} captures, max ${P.LINT_MAX_CAPTURES}`);
                score -= A.SCORE_PENALTY_CAPTURES;
            }
            if (!anchors.length) {
                warnings.push("No strong anchors detected");
                score -= A.SCORE_PENALTY_NO_ANCHORS;
            }

            return { score: Math.max(A.SCORE_MIN, Math.min(A.SCORE_MAX, score)), anchors, warnings, errors };
        };

        const findAnalysis = analyzePattern(findStr, true);
        const matchAnalysis = matchPattern ? analyzePattern(matchPattern, false) : null;
        const canonFind = canonicalizeMatch(findStr);
        const moduleIds = u.searchModulesOptimized(src => src.includes(canonFind), P.LINT_EARLY_EXIT);
        const allErrors = [...findAnalysis.errors, ...(matchAnalysis?.errors ?? [])];
        const allWarnings = [...findAnalysis.warnings, ...(matchAnalysis?.warnings ?? [])];

        if (moduleIds.length === 0) {
            allErrors.push("Find matches no modules");
            findAnalysis.score = Math.max(A.SCORE_MIN, findAnalysis.score - A.SCORE_PENALTY_NO_MATCH);
        } else if (moduleIds.length > 1) {
            allWarnings.push(`Find matches ${moduleIds.length} modules`);
            findAnalysis.score = Math.max(A.SCORE_MIN, findAnalysis.score - A.SCORE_PENALTY_AMBIGUOUS);
        }

        const overallScore = matchAnalysis ? Math.round((findAnalysis.score + matchAnalysis.score) / 2) : findAnalysis.score;

        return {
            find: { pattern: findStr.slice(0, P.LINT_PREVIEW_SLICE), ...findAnalysis, unique: moduleIds.length === 1, moduleCount: moduleIds.length },
            match: matchAnalysis ? { pattern: matchPattern!.slice(0, P.LINT_PREVIEW_SLICE), ...matchAnalysis } : undefined,
            overallScore,
            verdict: allErrors.length ? "BROKEN" : overallScore >= 7 ? "GOOD" : overallScore >= 4 ? "ACCEPTABLE" : "NEEDS_WORK",
            allWarnings: allWarnings.length ? allWarnings : undefined,
            allErrors: allErrors.length ? allErrors : undefined,
        };
    }

    if (action === "finds") {
        const specs = args.finders;
        if (!specs?.length) return { error: true, message: "finders array required" };

        const results: FinderResult[] = [];
        let found = 0,
            broken = 0;

        for (const spec of specs.slice(0, P.FINDS_MAX_SPECS)) {
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
            results: results.filter(r => !r.found || args.showValid).slice(0, P.FINDS_RESULT_LIMIT),
            allResults: args.showValid ? undefined : `${found} valid finders hidden, use showValid to include`,
        };
    }

    if (action === "benchmark") {
        if (!pluginName) return u.missingArg("pluginName");

        const plugin = plugins[pluginName];
        if (!plugin) return { error: true, message: `Plugin "${pluginName}" not found` };
        if (!plugin.patches?.length) return { name: pluginName, patchCount: 0, message: "No patches" };

        const iters = u.clampIters(args.iterations, P.BENCHMARK_DEFAULT_ITERS);
        const numRounds = u.clampRounds(args.rounds, P.BENCHMARK_DEFAULT_ROUNDS);
        const results: Array<Record<string, unknown>> = [];

        for (const [patchIdx, patch] of plugin.patches.entries()) {
            const rawFind = u.patchFindAsString(patch.find);
            const moduleId = u.searchModulesOptimized(u.canonFindMatcher(patch.find).test, P.COMPARE_EARLY_EXIT)[0];
            if (!moduleId) {
                results.push({ patchIndex: patchIdx, find: rawFind.slice(0, P.SLOWSCAN_MATCH_SLICE), error: "Module not found" });
                continue;
            }

            const source = u.getModuleSource(moduleId);

            for (const [repIdx, rep] of u.getReplacements(patch).entries()) {
                if (!rep.match) continue;
                let regex: RegExp;
                try {
                    regex = u.buildPatchRegex(rep.match);
                } catch {
                    u.mcpLogger.warn(`patch benchmark: invalid match regex in ${pluginName} patch ${patchIdx}`);
                    results.push({ patchIndex: patchIdx, replacementIndex: repIdx, error: "Invalid match regex" });
                    continue;
                }
                const replaceStr = typeof rep.replace === "string" ? rep.replace : "$&";
                const bench = u.benchmarkReplace(source, regex, replaceStr, iters, numRounds);

                results.push({
                    patchIndex: patchIdx,
                    replacementIndex: repIdx,
                    moduleId,
                    moduleSize: source.length,
                    match: String(rep.match).slice(0, P.SLOWSCAN_MATCH_SLICE),
                    coldMs: bench.coldMs,
                    wouldFlagSlow: bench.wouldFlagSlow,
                    medianUs: bench.medianUs,
                    roundsUs: bench.roundsUs,
                });
            }
        }

        const slowCount = results.filter(r => (r as { wouldFlagSlow?: boolean }).wouldFlagSlow).length;
        return { plugin: pluginName, iterations: iters, rounds: numRounds, slowCount, results };
    }

    if (action === "compare") {
        if (!findStr) return u.missingArg("find");
        if (!args.matchA || !args.matchB) return { error: true, message: "matchA and matchB required" };

        const canonFind = canonicalizeMatch(findStr);
        const moduleId = u.searchModulesOptimized(src => src.includes(canonFind), P.COMPARE_EARLY_EXIT)[0];
        if (!moduleId) return { error: true, message: "Find matches no module" };

        const source = u.getModuleSource(moduleId);
        const iters = u.clampIters(args.iterations, P.BENCHMARK_DEFAULT_ITERS);
        const numRounds = u.clampRounds(args.rounds, P.COMPARE_DEFAULT_ROUNDS);

        type BenchErr = { label: string; error: string; match?: string };
        type BenchRow = { label: string; match: string; replace: string; matched: string; coldMs: number; medianUs: number; roundsUs: number[] };
        const benchOne = (label: string, matchStr: string, replaceStr: string): BenchErr | BenchRow => {
            let regex: RegExp;
            try {
                regex = u.buildPatchRegex(matchStr);
            } catch {
                return { label, error: "Invalid regex" };
            }

            const matchResult = source.match(regex);
            if (!matchResult) return { label, error: "Match failed", match: matchStr };

            const bench = u.benchmarkReplace(source, regex, replaceStr, iters, numRounds);
            return {
                label,
                match: matchStr.slice(0, P.COMPARE_MATCH_SLICE),
                replace: replaceStr.slice(0, P.COMPARE_REPLACE_SLICE),
                matched: matchResult[0].slice(0, P.COMPARE_MATCHED_SLICE),
                coldMs: bench.coldMs,
                medianUs: bench.medianUs,
                roundsUs: bench.roundsUs,
            };
        };

        const replaceA = args.replaceA ?? "$&";
        const replaceB = args.replaceB ?? "$&";
        const a = benchOne("A", args.matchA, replaceA);
        const b = benchOne("B", args.matchB, replaceB);

        const isRow = (x: BenchErr | BenchRow): x is BenchRow => !("error" in x);
        let winner: string | undefined;
        let speedup: string | undefined;
        if (isRow(a) && isRow(b)) {
            winner = a.medianUs <= b.medianUs ? "A" : "B";
            const ratio = Math.max(a.medianUs, b.medianUs) / Math.min(a.medianUs, b.medianUs);
            speedup = ratio.toFixed(2) + "x";
        }

        let equivalent: boolean | undefined;
        try {
            const regexA = u.buildPatchRegex(args.matchA);
            const regexB = u.buildPatchRegex(args.matchB);
            equivalent = source.replace(regexA, replaceA) === source.replace(regexB, replaceB);
        } catch {
            /* */
        }

        return { find: findStr, moduleId, moduleSize: source.length, iterations: iters, rounds: numRounds, a, b, winner, speedup, equivalent };
    }

    if (action === "slowscan") {
        const iters = u.clamp(args.iterations, P.SLOWSCAN_DEFAULT_ITERS, 100, P.SLOWSCAN_MAX_ITERS);
        const topN = u.clamp(args.limit, P.SLOWSCAN_DEFAULT_TOP_N, 1, P.SLOWSCAN_MAX_TOP_N);

        const allResults: Array<{ plugin: string; patchIndex: number; replacementIndex: number; moduleId: string; moduleSize: number; match: string; coldMs: number; medianUs: number }> = [];

        for (const [nm, plugin] of Object.entries(plugins)) {
            if (!plugin.patches?.length) continue;

            for (const [patchIdx, patch] of plugin.patches.entries()) {
                const rawFind = u.patchFindAsString(patch.find);
                const moduleId = u.searchModulesOptimized(u.canonFindMatcher(patch.find).test, P.COMPARE_EARLY_EXIT)[0];
                if (!moduleId) continue;

                const source = u.getModuleSource(moduleId);

                for (const [repIdx, rep] of u.getReplacements(patch).entries()) {
                    if (!rep.match) continue;
                    let regex: RegExp;
                    try {
                        regex = u.buildPatchRegex(rep.match);
                    } catch {
                        u.mcpLogger.warn(`patch slowscan: invalid match regex in ${nm} patch ${patchIdx}`);
                        continue;
                    }
                    const replaceStr = typeof rep.replace === "string" ? rep.replace : "$&";
                    const bench = u.benchmarkReplace(source, regex, replaceStr, iters, 1);

                    allResults.push({
                        plugin: nm,
                        patchIndex: patchIdx,
                        replacementIndex: repIdx,
                        moduleId,
                        moduleSize: source.length,
                        match: String(rep.match).slice(0, P.SLOWSCAN_MATCH_SLICE),
                        coldMs: bench.coldMs,
                        medianUs: bench.medianUs,
                    });
                }
            }
        }

        allResults.sort((a, b) => b.medianUs - a.medianUs);
        const slowest = allResults.slice(0, topN);
        const flaggedSlow = allResults.filter(r => r.coldMs > 5).length;
        const averageUs = allResults.length
            ? +(allResults.reduce((s, r) => s + r.medianUs, 0) / allResults.length).toFixed(2)
            : 0;

        return { totalPatches: allResults.length, flaggedSlow, averageUs, slowest };
    }

    if (action === "conflicts") {
        const modulePlugins = new Map<string, Array<{ plugin: string; find: string; patchIndex: number }>>();

        for (const [nm, plugin] of Object.entries(plugins)) {
            if (!plugin.patches?.length) continue;
            for (const [patchIdx, patch] of plugin.patches.entries()) {
                const rawFind = u.patchFindAsString(patch.find);
                const moduleIds = u.searchModulesOptimized(u.canonFindMatcher(patch.find).test, P.CONFLICTS_EARLY_EXIT);
                for (const mid of moduleIds) {
                    if (!modulePlugins.has(mid)) modulePlugins.set(mid, []);
                    modulePlugins.get(mid)!.push({ plugin: nm, find: rawFind.slice(0, P.CONFLICTS_FIND_SLICE), patchIndex: patchIdx });
                }
            }
        }

        const conflicts = [...modulePlugins.entries()]
            .filter(([, entries]) => {
                const uniquePlugins = new Set(entries.map(e => e.plugin));
                return uniquePlugins.size > 1;
            })
            .map(([moduleId, entries]) => {
                const uniquePlugins = [...new Set(entries.map(e => e.plugin))];
                return { moduleId, moduleSize: u.getModuleSource(moduleId).length, pluginCount: uniquePlugins.length, plugins: entries };
            })
            .sort((a, b) => b.pluginCount - a.pluginCount)
            .slice(0, args.limit ?? P.CONFLICTS_DEFAULT_TOP_N);

        return { totalConflictingModules: conflicts.length, conflicts };
    }

    if (action === "diff") {
        const moduleId = args.id ?? (findStr ? u.searchModulesOptimized(src => src.includes(canonicalizeMatch(findStr)), P.DIFF_EARLY_EXIT)[0] : undefined);
        if (!moduleId) return { error: true, message: "id or find required" };

        const source = u.getModuleSource(moduleId);
        if (!source) return { error: true, message: `Module ${moduleId} not found` };

        const allPatches: Array<{ plugin: string; find: string; match: string; replace: string }> = [];
        for (const [nm, plugin] of Object.entries(plugins)) {
            if (!plugin.patches?.length) continue;
            for (const patch of plugin.patches) {
                const rawFind = u.patchFindAsString(patch.find);
                if (!u.canonFindMatcher(patch.find).test(source)) continue;

                for (const rep of u.getReplacements(patch)) {
                    allPatches.push({
                        plugin: nm,
                        find: rawFind.slice(0, P.DIFF_FIND_SLICE),
                        match: String(rep.match).slice(0, P.DIFF_MATCH_SLICE),
                        replace: typeof rep.replace === "string" ? rep.replace.slice(0, P.DIFF_REPLACE_SLICE) : "[function]",
                    });
                }
            }
        }

        if (!allPatches.length) return { moduleId, patched: false, moduleSize: source.length, message: "No plugins target this module" };

        return {
            moduleId,
            patched: true,
            pluginCount: new Set(allPatches.map(p => p.plugin)).size,
            patchCount: allPatches.length,
            moduleSize: source.length,
            patches: allPatches,
        };
    }

    if (action === "broken") {
        const unconsumed = (Vencord.WebpackPatcher as { patches: Array<{ plugin: string; find: string | RegExp; all: boolean; replacement: unknown }> }).patches.filter(p => !p.all);

        const results = unconsumed.map(patch => {
            const rawFind = u.patchFindAsString(patch.find);
            const matcher = u.canonFindMatcher(patch.find);
            const canonFind = matcher.canonical;
            const moduleCount = matcher.isRegex
                ? u.searchModulesOptimized(matcher.test, P.BROKEN_EARLY_EXIT).length
                : u.countModuleMatchesFast(canonFind, P.BROKEN_EARLY_EXIT);
            const usesIntl = rawFind.includes("#{intl::");
            const info: Record<string, unknown> = {
                plugin: patch.plugin,
                find: rawFind.slice(0, P.BROKEN_FIND_SLICE),
                moduleCount,
            };

            if (moduleCount === 0) {
                info.reason = "Find matches no modules";
                if (usesIntl) {
                    const probe = u.probeIntlKey(rawFind);
                    if (probe) {
                        info.intlKey = probe.intlKey;
                        info.intlKeyValid = probe.intlStatus === "key_valid_but_unused";
                    }
                    info.canonicalized = canonFind.slice(0, P.BROKEN_CANON_SLICE);
                }
                const fragments = canonFind.split(/(?=[.,()[\]{}:;=!&|?])|(?<=[.,()[\]{}:;=!&|?])/).filter(f => f.length >= P.BROKEN_FRAGMENT_MIN_LEN);
                for (const frag of fragments.slice(0, P.BROKEN_FRAGMENT_MAX)) {
                    const fragMatches = u.searchModulesOptimized(src => src.includes(frag), P.BROKEN_FRAGMENT_EARLY_EXIT);
                    if (fragMatches.length) {
                        info.partialMatch = { fragment: frag.slice(0, P.BROKEN_FRAGMENT_SLICE), modules: fragMatches.slice(0, P.BROKEN_FRAGMENT_PREVIEW) };
                        break;
                    }
                }
            } else {
                info.reason = "Find matched but replacements had no effect or errored";
            }

            return info;
        });

        return { totalBroken: results.length, patches: results };
    }

    return { error: true, message: "Unknown action. Valid: unique, plugin, analyze, lint, finds, benchmark, compare, slowscan, conflicts, diff, broken" };
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
