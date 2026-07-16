/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { runtimeHashMessageKey } from "@utils/intlHash";
import { canonicalizeMatch, canonicalizeReplace } from "@utils/patches";

import { generateFinds } from "../finds/genFinds";
import { diagnoseMatch, literalRuns } from "../finds/matchRepair";
import { type OverlapPatch, simulatePatchOverlaps } from "../finds/patchOverlap";
import { FinderResult, FinderSpec, PatchToolArgs, PluginPatch, PluginReplacement, ToolResult } from "../types";
import { filters, findAll, findStore, plugins, webpackPatches } from "../webpack";
import { recentConsole } from "./console_tool";
import { FORBIDDEN_PATCH_PATTERNS, LIMITS, MINIFIED_VARS_PATTERN } from "./constants";
import * as u from "./utils";

const P = LIMITS.PATCH;
const A = LIMITS.ANALYSIS;

type ReplFlags = { noWarn?: boolean; fromBuild?: number; toBuild?: number };

interface ReplacementAnalysis {
    match?: string;
    replace: string;
    captureCount?: number;
    unusedCaptures?: number[];
    invalidBackrefs?: number[];
    invalidNamedRefs?: string[];
    matchFound?: boolean;
    matchedModules?: number;
    totalCandidates?: number;
    syntaxValid?: boolean;
    syntaxError?: string;
    ambiguousMatches?: Array<{ moduleId: string; matched: boolean; syntaxValid?: boolean; syntaxError?: string }>;
    flags?: ReplFlags;
    suppressedBy?: string;
}

interface AnalyzeIssue {
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
    likelyNotLoaded?: boolean;
}

function replacePreview(replace: PluginReplacement["replace"], cap: number): string {
    return typeof replace === "string" ? replace.slice(0, cap) : "[function]";
}

function verifyReplacement(matchRegex: RegExp, replace: PluginReplacement["replace"], source: string): { matched: boolean; syntaxValid?: boolean; syntaxError?: string } {
    matchRegex.lastIndex = 0;
    const matched = matchRegex.test(source);
    if (!matched || typeof replace !== "string") return { matched };
    try {
        const err = u.checkJsSyntax(source.replace(matchRegex, replace));
        return err ? { matched: true, syntaxValid: false, syntaxError: err.slice(0, 200) } : { matched: true, syntaxValid: true };
    } catch (e) {
        return { matched: true, syntaxValid: false, syntaxError: `Replace threw: ${u.errMsg(e)}` };
    }
}

function analyzeReplacement(r: PluginReplacement, modules: Array<{ id: string; source: string }>, parent?: PluginPatch): ReplacementAnalysis {
    const out: ReplacementAnalysis = {
        match: r.match?.toString().slice(0, P.REPLACEMENT_MATCH_SLICE),
        replace: replacePreview(r.replace, P.REPLACEMENT_REPLACE_SLICE),
    };

    const flags: ReplFlags = { ...(r.noWarn && { noWarn: true }), ...(r.fromBuild != null && { fromBuild: r.fromBuild }), ...(r.toBuild != null && { toBuild: r.toBuild }) };
    if (Object.keys(flags).length) out.flags = flags;

    if (r.noWarn || parent?.noWarn) out.suppressedBy = r.noWarn ? "replacement.noWarn" : "patch.noWarn";

    const { match } = r;
    if (!match) return out;
    const matchRegex = u.safeCall<RegExp | null>(() => u.buildPatchRegex(match), null);
    if (!matchRegex) return out;

    const captureCount = u.countUnescapedCaptures(matchRegex.source);
    out.captureCount = captureCount;

    if (typeof r.replace === "string") {
        const referencedNum = new Set([...r.replace.matchAll(/\$(\d+)/g)].map(m => parseInt(m[1], 10)));
        const referencedNames = new Set([...r.replace.matchAll(/\$<([A-Za-z_$][\w$]*)>/g)].map(m => m[1]));
        const namedGroups = u.extractCaptureNames(matchRegex.source);
        const numericCount = captureCount - namedGroups.length;

        const unused: number[] = [];
        for (let i = 1; i <= numericCount; i++) if (!referencedNum.has(i)) unused.push(i);
        const invalid = [...referencedNum].filter(n => n > captureCount || n < 1);
        const invalidNames = [...referencedNames].filter(n => !namedGroups.includes(n));
        if (unused.length) out.unusedCaptures = unused;
        if (invalid.length) out.invalidBackrefs = invalid;
        if (invalidNames.length) out.invalidNamedRefs = invalidNames;
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

export async function handlePatch(args: PatchToolArgs): Promise<ToolResult> {
    const { action, find: findStr, str, pluginName } = args;

    if (action === "unique" || (str && !action)) {
        const searchStr = str || findStr;
        if (!searchStr) return { error: true, message: "str or find required" };

        const canonSearch = canonicalizeMatch(searchStr);
        const moduleIds = u.findModuleIds(source => source.includes(canonSearch), P.UNIQUE_EARLY_EXIT);
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
            const similar = u.filterBySubstring(Object.keys(plugins), pluginName, n => n).slice(0, P.PLUGIN_SIMILAR_SUGGESTIONS);
            return { error: true, message: `Plugin "${pluginName}" not found`, suggestions: similar.length ? similar : undefined };
        }

        if (!plugin.patches?.length) {
            return { name: pluginName, enabled: plugin.started ?? false, patchCount: 0 };
        }

        let ok = 0, broken = 0, ambiguous = 0;

        const patchDetails = plugin.patches.map((patch, index) => {
            const rawFind = u.patchFindAsString(patch.find);
            const matcher = u.canonFindMatcher(patch.find);
            const canonFind = matcher.canonical;
            const matchingModules = u.findModuleIds(matcher.test, P.PLUGIN_MATCH_EARLY_EXIT);
            const moduleCount = matchingModules.length;

            const expectMultiple = patch.all === true;
            const rawStatus = moduleCount === 0 ? "NO_MATCH" : moduleCount === 1 ? "OK" : "MULTIPLE_MATCH";
            const status = rawStatus === "MULTIPLE_MATCH" && expectMultiple ? "OK_ALL" : rawStatus;

            if (status === "OK" || status === "OK_ALL") ok++;
            else if (status === "NO_MATCH") broken++;
            else ambiguous++;

            const candidateModules = matchingModules.map(id => ({ id, source: u.getModuleSource(id) }));
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
                Object.assign(info, u.probeIntlKey(rawFind));
            }

            return info;
        });

        return {
            found: true,
            name: pluginName,
            enabled: plugin.started ?? false,
            patchCount: plugin.patches.length,
            summary: { ok, broken, ambiguous },
            health: u.healthStatus(broken, plugin.patches.length),
            patches: patchDetails,
        };
    }

    if (action === "analyze") {
        const showNoMatch = args.showNoMatch ?? true;
        const showMultiMatch = args.showMultiMatch ?? true;
        const showValid = args.showValid ?? false;

        const issues: AnalyzeIssue[] = [];

        const stats = { totalPlugins: 0, totalPatches: 0, noMatch: 0, multiMatch: 0, slowPatches: 0, validPatches: 0, likelyNotLoaded: 0 };
        const patchInfos: Array<{ plugin: string; enabled: boolean; patchIndex: number; rawFind: string; canonFind: string; matcher: u.CanonFindMatcher; all: boolean; noWarn: boolean }> = [];

        for (const [nm, plugin] of Object.entries(plugins)) {
            if (pluginName && !nm.toLowerCase().includes(pluginName.toLowerCase())) continue;
            if (!plugin.patches?.length) continue;

            stats.totalPlugins++;
            const enabled = plugin.started ?? false;
            stats.totalPatches += plugin.patches.length;
            plugin.patches.forEach((patch, i) => {
                const matcher = u.canonFindMatcher(patch.find);
                patchInfos.push({
                    plugin: nm,
                    enabled,
                    patchIndex: i,
                    rawFind: u.patchFindAsString(patch.find),
                    canonFind: matcher.canonical,
                    matcher,
                    all: !!patch.all,
                    noWarn: !!patch.noWarn,
                });
            });
        }

        const stringOnly = patchInfos.filter(p => !p.matcher.isRegex);
        const uniqueFinds = [...new Set(stringOnly.map(p => p.canonFind))];
        const batchResults = u.batchCountModuleMatches(uniqueFinds, P.UNIQUE_EARLY_EXIT);

        for (const { plugin: nm, enabled, patchIndex: i, rawFind, canonFind, matcher, all, noWarn } of patchInfos) {
            const moduleCount = matcher.isRegex
                ? u.findModuleIds(matcher.test, P.UNIQUE_EARLY_EXIT).length
                : (batchResults.get(canonFind)?.count ?? 0);
            const usesIntl = rawFind.includes("#{intl::");
            const displayFind = usesIntl ? rawFind.slice(0, P.ANALYZE_FIND_SLICE) : canonFind.slice(0, P.ANALYZE_FIND_SLICE);
            const mkIssue = (issue: string, severity: string, moduleCount: number): AnalyzeIssue => ({ plugin: nm, enabled: enabled ? true : undefined, patchIndex: i, find: displayFind, issue, severity, moduleCount });

            if (moduleCount === 0) {
                if (noWarn) { stats.validPatches++; continue; }
                stats.noMatch++;
                if (showNoMatch) {
                    const issue = { ...mkIssue("NO_MATCH", "error", 0), details: "Find matches no modules" };

                    if (usesIntl && canonFind !== rawFind) {
                        issue.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                        const probe = u.probeIntlKey(rawFind);
                        if (probe) {
                            Object.assign(issue, probe);
                            if (probe.intlStatus === "key_valid_but_unused") {
                                const h = u.runtimeHashMessageKey(probe.intlKey);
                                const usedInLoaded = u.countModuleMatches(`.t.${h}`, 1) > 0 || u.countModuleMatches(`.t["${h}"]`, 1) > 0;
                                if (usedInLoaded) {
                                    issue.details = "Intl key is valid and its module is loaded, but this find does not match. The find may be stale.";
                                } else {
                                    issue.severity = "warning";
                                    issue.likelyNotLoaded = true;
                                    issue.details = "Intl key is valid but no loaded module uses it. The target module is likely not loaded this session. The patch is probably fine. Open the target screen to confirm.";
                                    stats.likelyNotLoaded++;
                                }
                            } else {
                                issue.details = "Intl key not in Discord definitions";
                            }
                        }
                    }
                    issues.push(issue);
                }
            } else if (moduleCount > 1) {
                if (all) { stats.validPatches++; continue; }
                stats.multiMatch++;
                if (showMultiMatch) {
                    const issue = { ...mkIssue("MULTIPLE_MATCH", "warning", moduleCount), details: `Matches ${moduleCount}+ modules` };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                    issues.push(issue);
                }
            } else {
                stats.validPatches++;
                if (showValid) {
                    const issue = mkIssue("OK", "info", 1);
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, P.ANALYZE_CANON_SLICE);
                    issues.push(issue);
                }
            }
        }

        const note = stats.likelyNotLoaded > 0 ? `${stats.likelyNotLoaded} NO_MATCH patch(es) target valid intl keys whose module isn't loaded this session and are likely fine, not broken` : undefined;
        return { stats, issueCount: stats.noMatch + stats.multiMatch, note, issues: issues.slice(0, P.ANALYZE_MAX_ISSUES) };
    }

    if (action === "lint") {
        if (!findStr) return u.missingArg("find");

        const matchPattern = args.match;

        const analyzePattern = (pattern: string, isFind: boolean) => {
            const warnings: string[] = [];
            const errors: string[] = [];
            const anchors: string[] = [];
            let score = A.BASE_SCORE;
            const note = (list: string[], msg: string, delta: number) => { list.push(msg); score += delta; };

            if (pattern.includes("#{intl::")) note(anchors, "intl", A.SCORE_INTL);
            if (/"[^"]{3,}"/.test(pattern) || /'[^']{3,}'/.test(pattern)) note(anchors, "string-literal", A.SCORE_STRING_LITERAL);
            if (/[A-Za-z_$][\w$]*:/.test(pattern)) note(anchors, "prop-name", A.SCORE_PROP_NAME);
            if (pattern.includes("\\i")) note(anchors, "identifier", A.SCORE_IDENTIFIER);
            if (/\(\?<=/.test(pattern)) note(anchors, "lookbehind", A.SCORE_LOOKBEHIND);

            const minifiedMatches = pattern.match(MINIFIED_VARS_PATTERN);
            if (minifiedMatches && !pattern.includes("\\i")) note(errors, `Hardcoded minified vars: ${[...new Set(minifiedMatches)].join(", ")}`, -A.SCORE_PENALTY_MINIFIED);

            for (const forbidden of FORBIDDEN_PATCH_PATTERNS) if (forbidden.test(pattern)) note(errors, `Forbidden pattern: ${forbidden.source}`, -A.SCORE_PENALTY_FORBIDDEN);

            if (isFind && pattern.length < P.LINT_MIN_FIND_LENGTH && !pattern.includes("#{intl::")) note(warnings, `Find < ${P.LINT_MIN_FIND_LENGTH} chars, may not be unique`, -A.SCORE_PENALTY_SHORT);
            if (/\b(function|return|if|for|while|const|let)\b/.test(pattern) && !pattern.includes("\\i")) note(warnings, "Anchored on generic keywords", -A.SCORE_PENALTY_GENERIC);
            if (/\.\+\??|\.\*\??/.test(pattern) && !/\.\{/.test(pattern)) note(warnings, "Unbounded wildcards, use .{0,N}", -A.SCORE_PENALTY_WILDCARD);
            if (pattern.length > P.LINT_MAX_FIND_LENGTH) note(warnings, `> ${P.LINT_MAX_FIND_LENGTH} chars, shorten`, -A.SCORE_PENALTY_LONG);

            const captures = u.countUnescapedCaptures(pattern);
            if (captures > P.LINT_MAX_CAPTURES) note(warnings, `${captures} captures, max ${P.LINT_MAX_CAPTURES}`, -A.SCORE_PENALTY_CAPTURES);
            if (!anchors.length) note(warnings, "No strong anchors detected", -A.SCORE_PENALTY_NO_ANCHORS);

            return { score: Math.max(A.SCORE_MIN, Math.min(A.SCORE_MAX, score)), anchors, warnings, errors };
        };

        const findAnalysis = analyzePattern(findStr, true);
        const matchAnalysis = matchPattern ? analyzePattern(matchPattern, false) : null;
        const canonFind = canonicalizeMatch(findStr);
        const moduleIds = u.findModuleIds(src => src.includes(canonFind), P.LINT_EARLY_EXIT);
        const allErrors = [...findAnalysis.errors, ...(matchAnalysis?.errors ?? [])];
        const allWarnings = [...findAnalysis.warnings, ...(matchAnalysis?.warnings ?? [])];

        if (moduleIds.length === 0) {
            allErrors.push("Find matches no modules");
            findAnalysis.score = Math.max(A.SCORE_MIN, findAnalysis.score - A.SCORE_PENALTY_NO_MATCH);
        } else if (moduleIds.length > 1) {
            allWarnings.push(`Find matches ${moduleIds.length} modules`);
            findAnalysis.score = Math.max(A.SCORE_MIN, findAnalysis.score - A.SCORE_PENALTY_AMBIGUOUS);
        }

        let matchWorks: boolean | undefined;
        if (matchPattern && matchAnalysis && moduleIds.length === 1) {
            const source = u.getModuleSource(moduleIds[0]);
            const regex = u.safeCall<RegExp | null>(() => u.buildPatchRegex(matchPattern), null);
            if (!regex) {
                allErrors.push("Match is not a valid regex");
                matchAnalysis.score = A.SCORE_MIN;
            } else if (/\([^)]*[*+][^)]*\)[*+]/.test(regex.source)) {
                allErrors.push("Match has a nested unbounded quantifier that can cause catastrophic backtracking and freeze the client. Rewrite with a bounded {0,N} or remove the outer quantifier");
                matchAnalysis.score = A.SCORE_MIN;
            } else {
                regex.lastIndex = 0;
                matchWorks = regex.test(source);
                if (!matchWorks) {
                    allErrors.push("Match regex does not match the target module (use testPatch to debug)");
                    matchAnalysis.score = Math.max(A.SCORE_MIN, matchAnalysis.score - A.SCORE_PENALTY_NO_MATCH);
                } else if (args.replace != null) {
                    const { replace } = args;
                    const syntaxOk = u.safeCall(() => u.checkJsSyntax(source.replace(regex, replace)) === null, false);
                    if (!syntaxOk) allErrors.push("Replacement produces invalid JS syntax");
                }
            }
        }

        const overallScore = matchAnalysis ? Math.round((findAnalysis.score + matchAnalysis.score) / 2) : findAnalysis.score;

        return {
            find: { pattern: findStr.slice(0, P.LINT_PREVIEW_SLICE), ...findAnalysis, unique: moduleIds.length === 1, moduleCount: moduleIds.length },
            match: matchPattern && matchAnalysis ? { pattern: matchPattern.slice(0, P.LINT_PREVIEW_SLICE), ...matchAnalysis, matchWorks } : undefined,
            overallScore,
            verdict: allErrors.length ? "BROKEN" : overallScore >= 7 ? "GOOD" : overallScore >= 4 ? "ACCEPTABLE" : "NEEDS_WORK",
            allWarnings: allWarnings.length ? allWarnings : undefined,
            allErrors: allErrors.length ? allErrors : undefined,
        };
    }

    if (action === "finds") {
        const specs = args.finders;
        if (!specs?.length) return { error: true, message: "finders array required" };

        const results = specs.slice(0, P.FINDS_MAX_SPECS).map(spec => validateFinder(spec));
        const found = results.filter(r => r.found).length;
        const broken = results.length - found;

        return {
            total: results.length,
            found,
            broken,
            health: u.healthStatus(broken, results.length),
            results: results.filter(r => !r.found || args.showValid).slice(0, P.FINDS_RESULT_LIMIT),
            allResults: args.showValid ? undefined : `${found} valid finders hidden, use showValid to include`,
        };
    }

    if (action === "conflicts") {
        const modulePlugins = new Map<string, Array<{ plugin: string; find: string; patchIndex: number }>>();

        for (const { name: nm, patch, index: patchIdx } of u.eachPatch()) {
            const rawFind = u.patchFindAsString(patch.find);
            const moduleIds = u.findModuleIds(u.canonFindMatcher(patch.find).test, P.CONFLICTS_EARLY_EXIT);
            for (const mid of moduleIds) {
                let list = modulePlugins.get(mid);
                if (!list) modulePlugins.set(mid, list = []);
                list.push({ plugin: nm, find: rawFind.slice(0, P.CONFLICTS_FIND_SLICE), patchIndex: patchIdx });
            }
        }

        const ranked = [...modulePlugins.entries()]
            .filter(([, entries]) => new Set(entries.map(e => e.plugin)).size > 1)
            .map(([moduleId, entries]) => ({ moduleId, moduleSize: u.getModuleSource(moduleId).length, pluginCount: new Set(entries.map(e => e.plugin)).size, plugins: entries }))
            .sort((a, b) => b.pluginCount - a.pluginCount);

        return { totalConflictingModules: ranked.length, conflicts: ranked.slice(0, args.limit ?? P.CONFLICTS_DEFAULT_TOP_N) };
    }

    if (action === "overlaps") {
        let moduleId = args.id;
        if (moduleId == null && findStr) {
            const canon = canonicalizeMatch(findStr);
            moduleId = u.findModuleIds(src => src.includes(canon), P.DIFF_EARLY_EXIT)[0];
        }
        if (!moduleId) return { error: true, message: findStr ? `No loaded module matches the find: ${findStr.slice(0, 80)}` : "id or find required" };

        const source = u.getModuleSource(moduleId);
        if (!source) return u.moduleNotFound(moduleId);

        const appliedBy = new Set(u.getModulePatchedBy(moduleId));
        const overlapPatches: OverlapPatch[] = [];
        let skippedFunctionReplaces = 0;
        for (const { name: nm, patch } of u.eachPatch()) {
            if (!appliedBy.has(nm)) continue;
            if (!u.canonFindMatcher(patch.find).test(source)) continue;
            for (const rep of u.getReplacements(patch)) {
                if (typeof rep.replace !== "string") {
                    skippedFunctionReplaces++;
                    continue;
                }
                if (rep.match == null) continue;
                overlapPatches.push({ plugin: nm, match: canonicalizeMatch(rep.match), replace: canonicalizeReplace(rep.replace, nm) });
            }
        }

        if (overlapPatches.length < 2) {
            return { moduleId, patchCount: overlapPatches.length, ...(skippedFunctionReplaces ? { skippedFunctionReplaces } : {}), conflicts: 0, message: "Fewer than two simulatable string-replacement patches actually apply to this module, no ordering conflict is possible" };
        }

        const report = simulatePatchOverlaps(source, overlapPatches);
        return {
            moduleId,
            moduleSize: source.length,
            patchCount: overlapPatches.length,
            ...(skippedFunctionReplaces ? { skippedFunctionReplaces } : {}),
            conflicts: report.conflicts,
            patches: report.patches.map(r => ({ plugin: r.plugin, matched: r.matched, brokenByPrior: r.brokenByPrior, note: r.note })),
            ...(report.conflicts
                ? { warning: `${report.conflicts} replacement(s) fail because an earlier plugin rewrote this module first. Registration order matters here` }
                : { note: "All patches apply cleanly in registration order" }),
        };
    }

    if (action === "diff") {
        let moduleId = args.id;
        if (moduleId == null && findStr) {
            const canon = canonicalizeMatch(findStr);
            moduleId = u.findModuleIds(src => src.includes(canon), P.DIFF_EARLY_EXIT)[0];
        }
        if (!moduleId) return { error: true, message: "id or find required" };

        const source = u.getModuleSource(moduleId);
        if (!source) return u.moduleNotFound(moduleId);

        const allPatches = [...u.eachPatch()]
            .filter(({ patch }) => u.canonFindMatcher(patch.find).test(source))
            .flatMap(({ name: nm, patch }) => u.getReplacements(patch).map(rep => ({
                plugin: nm,
                find: u.patchFindAsString(patch.find).slice(0, P.DIFF_FIND_SLICE),
                match: String(rep.match).slice(0, P.DIFF_MATCH_SLICE),
                replace: replacePreview(rep.replace, P.DIFF_REPLACE_SLICE),
            })));

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
        const unconsumed = webpackPatches.filter(p => !p.all);

        const results = unconsumed.map(patch => {
            const rawFind = u.patchFindAsString(patch.find);
            const matcher = u.canonFindMatcher(patch.find);
            const canonFind = matcher.canonical;
            const moduleCount = matcher.isRegex
                ? u.findModuleIds(matcher.test, P.BROKEN_EARLY_EXIT).length
                : u.countModuleMatches(canonFind, P.BROKEN_EARLY_EXIT);
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
                    const fragMatches = u.findModuleIds(src => src.includes(frag), P.BROKEN_FRAGMENT_EARLY_EXIT);
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

    if (action === "verifyApplied") {
        if (!pluginName) return u.missingArg("pluginName");
        const entry = Object.entries(plugins).find(([nm]) => nm.toLowerCase() === pluginName.toLowerCase());
        if (!entry) return { error: true, message: `Plugin not found: ${pluginName}` };
        const [resolvedName, plugin] = entry;
        const enabled = plugin.started ?? false;

        const results = (plugin.patches ?? []).map((patch, index) => {
            const matcher = u.canonFindMatcher(patch.find);
            const ids = u.findModuleIds(matcher.test, 3);
            const modules = ids.map(mid => {
                const patchedBy = u.getModulePatchedBy(mid);
                const original = u.getModuleSource(mid);
                const patched = u.extractModule(mid, true);
                const patchedClean = patched.startsWith("//") ? patched.slice(patched.indexOf("\n") + 1) : patched;
                return {
                    moduleId: mid,
                    appliedByThisPlugin: patchedBy.includes(resolvedName),
                    sourceChanged: patchedClean !== original,
                    patchedBy: patchedBy.length ? patchedBy : undefined,
                };
            });
            const status = ids.length === 0 ? "FIND_DEAD"
                : ids.length > 1 ? "FIND_AMBIGUOUS"
                : modules[0].appliedByThisPlugin && modules[0].sourceChanged ? "APPLIED"
                : modules[0].appliedByThisPlugin ? "CONSUMED_NO_CHANGE"
                : "NOT_APPLIED";
            return { index, find: u.patchFindAsString(patch.find).slice(0, 100), status, modules };
        });

        const errors = recentConsole("error", 120_000, 20);
        const applied = results.filter(r => r.status === "APPLIED").length;
        const findDead = results.filter(r => r.status === "FIND_DEAD").length;
        const verdict = !enabled ? "PLUGIN_DISABLED"
            : results.length === 0 ? "NO_PATCHES"
            : applied === results.length ? "ALL_APPLIED"
            : applied + findDead === results.length ? "APPLIED_WHERE_LOADED"
            : "INCOMPLETE";
        return {
            plugin: resolvedName,
            enabled,
            patchCount: results.length,
            applied,
            findDead: findDead || undefined,
            verdict,
            note: !enabled
                ? "Plugin is disabled. Its patches are not registered, so NOT_APPLIED per patch is expected and does not indicate breakage."
                : findDead && verdict !== "ALL_APPLIED"
                ? "FIND_DEAD can mean the target module is in a lazy chunk not loaded this session, not necessarily a broken find. Open the relevant UI and re-verify to confirm."
                : undefined,
            ambientConsoleErrorsLast2Min: errors.length,
            ambientErrorsNote: errors.length
                ? "Renderer errors seen in the last 2 min. These are AMBIENT (from any plugin/tool, not attributed to this plugin's patches) and do not affect the verdict. Use only as a weak follow-up signal."
                : undefined,
            recentErrors: errors.length ? errors.slice(-5).map(e => e.text.slice(0, 160)) : undefined,
            patches: results,
        };
    }

    if (action === "suggestFix") {
        const max = u.clamp(args.limit, 10, 1, 50);
        const canonMatchRe = args.match ? u.safeCall<RegExp | null>(() => u.buildPatchRegex(args.match!), null) : null;
        const matchInvalid = !!args.match && !canonMatchRe;

        const probeCache = new Map<string, string[]>();
        const probeScan = (probe: string, earlyExit: number): string[] => {
            const key = `${earlyExit}:${probe}`;
            let ids = probeCache.get(key);
            if (!ids) { ids = u.findModuleIds(src => src.includes(probe), earlyExit); probeCache.set(key, ids); }
            return ids;
        };

        type Target = { plugin?: string; rawFind: string; canonFind: string };
        const targets: Target[] = [];
        if (args.find) {
            const m = u.canonFindMatcher(args.find);
            targets.push({ rawFind: args.find, canonFind: m.canonical });
        } else {
            for (const [nm, plugin] of Object.entries(plugins)) {
                if (pluginName && !nm.toLowerCase().includes(pluginName.toLowerCase())) continue;
                if (!plugin.patches?.length) continue;
                for (const patch of plugin.patches) {
                    const m = u.canonFindMatcher(patch.find);
                    if (m.isRegex) continue;
                    if (u.countModuleMatches(m.canonical, 2) === 0) {
                        targets.push({ plugin: nm, rawFind: u.patchFindAsString(patch.find), canonFind: m.canonical });
                    }
                }
            }
        }

        const suggestions = targets.slice(0, max).map(t => {
            const candidateIds: string[] = [];
            const seenIds = new Set<string>();
            const addIds = (ids: string[]) => {
                for (const id of ids) if (!seenIds.has(id) && candidateIds.length < 3) { seenIds.add(id); candidateIds.push(id); }
            };

            const hashes = new Set<string>();
            for (const im of t.rawFind.matchAll(/#\{intl::([\w$+/]+?)(?:::(\w+))?\}/g)) {
                const hash = im[2] === "raw" ? im[1] : runtimeHashMessageKey(im[1]);
                if (hash) hashes.add(hash);
            }
            for (const hm of t.canonFind.matchAll(/(?:\.|\[")([A-Za-z0-9+/]{6})(?:"\])?/g)) {
                if (u.getIntlKeyFromHash(hm[1])) hashes.add(hm[1]);
            }
            for (const hash of hashes) {
                if (candidateIds.length >= 3) break;
                addIds(u.findModuleIds(src => src.includes(`.t.${hash}`) || src.includes(`.t["${hash}"]`), 4));
            }

            if (candidateIds.length < 3) addIds(probeScan(t.canonFind, 4));

            if (candidateIds.length < 3) {
                const probes = new Set<string>();
                for (const frag of t.canonFind.split(/(?=[.,()[\]{}:;=!&|?])|(?<=[.,()[\]{}:;=!&|?])/).map(f => f.trim())) {
                    if (frag.length >= 6) probes.add(frag);
                }
                if (canonMatchRe) for (const lit of literalRuns(canonMatchRe.source, 5)) probes.add(lit);
                const freq = new Map<string, number>();
                let narrowest: string[] | null = null;
                for (const probe of [...probes].slice(0, 12)) {
                    const ids = probeScan(probe, 25);
                    if (ids.length === 0 || ids.length >= 25) continue;
                    for (const id of new Set(ids)) freq.set(id, (freq.get(id) ?? 0) + 1);
                    if (!narrowest || ids.length < narrowest.length) narrowest = ids;
                }
                const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
                const intersecting = ranked.filter(e => e[1] >= 2).map(e => e[0]);
                if (intersecting.length) addIds(intersecting);
                else if (narrowest && narrowest.length <= 5) addIds(narrowest);
            }

            const targetCandidates = candidateIds.slice(0, 3).map(id => {
                const source = u.getModuleSource(id);
                const finds = source ? generateFinds(source, { hashToKey: h => u.getIntlKeyFromHash(h), limit: 60, synthesizePairs: true }) : [];
                const literalFinds = finds.filter(f => !f.regex);
                const canonByFind = new Map(literalFinds.map(f => [f.find, canonicalizeMatch(f.find)]));
                const counts = u.batchCountModuleMatches([...new Set(canonByFind.values())], 2);
                const suggestedFinds = finds
                    .filter(f => {
                        if (f.regex) {
                            const re = u.safeCall<RegExp | null>(() => new RegExp(f.find), null);
                            return !!re && u.findModuleIds(src => re.test(src), 2).length === 1;
                        }
                        return (counts.get(canonByFind.get(f.find) ?? f.find)?.count ?? 0) === 1;
                    })
                    .slice(0, 3)
                    .map(f => ({ find: f.find, durability: f.durability, tier: f.tier, ...(f.regex && { regex: true, type: f.type }) }));
                const repair = canonMatchRe && source ? diagnoseMatch(source, canonMatchRe.source, canonMatchRe.flags) : undefined;
                const matchRepair = repair && {
                    status: repair.status,
                    failureKind: repair.failureKind,
                    ...(repair.adjustedPattern && { adjustedMatch: repair.adjustedPattern, note: repair.adjustmentNote }),
                    ...(repair.missingLiterals.length && { missingLiterals: repair.missingLiterals.slice(0, 5) })
                };
                const keep = suggestedFinds.length > 0 || !!matchRepair || (!canonMatchRe && finds.length > 0);
                return { moduleId: id, hint: u.getModuleHint(id), suggestedFinds, keep, ...(matchRepair && { matchRepair }) };
            }).filter(c => c.keep).map(({ keep, ...c }) => c);

            return { plugin: t.plugin, brokenFind: t.rawFind.slice(0, 120), targetCandidates };
        });

        const anyLocated = suggestions.some(s => s.targetCandidates.length > 0);
        return {
            count: suggestions.length,
            note: "For each broken find, the target module is located and fresh durable unique finds are generated. When no single token is unique, bounded-gap regex pair finds (regex:true, type 'pair') are offered instead. Pass `match` to also diagnose the match regex against each candidate: matchRepair reports whether it still fits and, when repairable, a verified adjusted match (widened bounded gaps / stripped stale lookarounds).",
            ...(matchInvalid && { matchWarning: "The provided `match` could not be parsed as a regex and was ignored. matchRepair was not computed. Pass it as /pattern/flags or a plain regex body." }),
            ...(suggestions.length && !anyLocated && {
                hint: "Could not relocate the target module. Relocation probes intl hashes, the full canonical find, and fragment/match-literal intersections. A find mutated INSIDE its single unique token (not just trailing junk) can defeat it. Try passing `match` too, or manually `search` for a surviving literal substring of the find.",
            }),
            suggestions
        };
    }

    return { error: true, message: "Unknown action. Valid: unique, plugin, analyze, lint, finds, conflicts, overlaps, diff, broken, suggestFix, verifyApplied" };
}

function validateFinder(spec: FinderSpec): FinderResult {
    const { type, args, plugin } = spec;
    const fail = (error: string): FinderResult => ({ type, args: args ?? [], plugin, found: false, error });
    const ok = (exportType: string): FinderResult => ({ type, args, plugin, found: true, exportType });
    if (!args?.length) return fail("No args provided");

    try {
        switch (type) {
            case "byProps": {
                const res = findAll(filters.byProps(...args));
                return res.length ? ok(typeof res[0]) : fail("No module exports these props");
            }
            case "byCode": {
                const res = findAll(filters.byCode(...args.map(canonicalizeMatch)));
                return res.length ? ok(typeof res[0]) : fail("No module contains this code");
            }
            case "store": {
                try {
                    return { type, args, plugin, found: findStore(args[0]) != null };
                } catch {
                    return fail(`Store "${args[0]}" not found`);
                }
            }
            case "componentByCode": {
                const res = findAll(filters.componentByCode(...args.map(canonicalizeMatch)));
                return res.length ? ok("component") : fail("No component contains this code");
            }
            case "exportedComponent": {
                const res = findAll(filters.byProps(...args));
                if (!res.length) return fail("No module exports this component");
                const exported = res[0]?.[args[0]];
                return exported ? ok(typeof exported) : fail(`Prop "${args[0]}" exists but is nullish`);
            }
            case "cssClasses":
            case "byClassNames": {
                const res = findAll(filters.byClassNames(...args), { topLevelOnly: true });
                return res.length ? ok("cssModule") : fail("No CSS module has these class names");
            }
            default:
                return fail(`Unknown finder type "${type}"`);
        }
    } catch (e) {
        return fail(e instanceof Error ? e.message.slice(0, 150) : String(e));
    }
}
