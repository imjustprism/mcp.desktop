/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { VencordPlugin } from "../types";
import {
    batchCountModuleMatches,
    intlHashExistsInDefinitions,
    runtimeHashMessageKey,
    searchModulesOptimized,
} from "./utils";

const MINIFIED_VARS = /(?<![a-zA-Z_$])([etnirsoclu])(?=\s*[,)}:.]|$)/g;
const FORBIDDEN_PATTERNS = [/\be,t,n\b/, /function\s*\(\s*e\s*\)/, /return!0/, /return!1/];

export async function handlePatchTool(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action as string | undefined;
    const findStr = args.find as string | undefined;
    const str = args.str as string | undefined;
    const pluginName = args.pluginName as string | undefined;

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
            valid: count === 1 ? "Safe to use as find string" : count === 0 ? "No modules found" : `Found in ${count} modules, not unique`
        };
    }

    if (action === "plugin") {
        if (!pluginName) return { error: true, message: "pluginName required" };

        const { plugins } = Vencord.Plugins;
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
        const showNoMatch = args.showNoMatch as boolean ?? true;
        const showMultiMatch = args.showMultiMatch as boolean ?? true;
        const showValid = args.showValid as boolean ?? false;

        const { plugins } = Vencord.Plugins;
        const issues: Array<{
            plugin: string;
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
        const patchInfos: Array<{ plugin: string; patchIndex: number; rawFind: string; canonFind: string; intlKey?: string }> = [];
        const intlKeyPattern = /#\{intl::([A-Z][A-Z0-9_]*)/;

        for (const [nm, plugin] of Object.entries(plugins) as [string, VencordPlugin][]) {
            if (pluginFilter && !nm.toLowerCase().includes(pluginFilter.toLowerCase())) continue;
            if (!plugin.patches?.length) continue;

            stats.totalPlugins++;
            for (let i = 0; i < plugin.patches.length; i++) {
                const patch = plugin.patches[i];
                stats.totalPatches++;

                const rawFind = typeof patch.find === "string" ? patch.find : patch.find?.toString() ?? "";
                const intlMatch = rawFind.match(intlKeyPattern);
                patchInfos.push({ plugin: nm, patchIndex: i, rawFind, canonFind: canonicalizeMatch(rawFind), intlKey: intlMatch?.[1] });
            }
        }

        const uniqueFinds = [...new Set(patchInfos.map(p => p.canonFind))];
        const batchResults = batchCountModuleMatches(uniqueFinds, 11);

        for (const { plugin: nm, patchIndex: i, rawFind, canonFind, intlKey } of patchInfos) {
            const { count: moduleCount } = batchResults.get(canonFind) ?? { count: 0 };
            const usesIntl = rawFind.includes("#{intl::");
            const displayFind = usesIntl ? rawFind.slice(0, 100) : canonFind.slice(0, 100);

            if (moduleCount === 0) {
                stats.noMatch++;
                if (showNoMatch) {
                    const issue: typeof issues[0] = { plugin: nm, patchIndex: i, find: displayFind, issue: "NO_MATCH", severity: "error", moduleCount: 0, details: "Find string doesn't match any module" };

                    if (usesIntl && canonFind !== rawFind) {
                        issue.canonicalizedFind = canonFind.slice(0, 100);
                        if (intlKey) {
                            issue.intlKey = intlKey;
                            const hash = runtimeHashMessageKey(intlKey);
                            const exists = intlHashExistsInDefinitions(hash);
                            issue.intlStatus = exists ? "key_valid_but_unused" : "key_not_found";
                            issue.details = exists ? "Intl key exists but is no longer used in Discord's code" : "Intl key not found in definitions";
                        }
                    }
                    issues.push(issue);
                }
            } else if (moduleCount > 1) {
                stats.multiMatch++;
                if (showMultiMatch) {
                    const issue: typeof issues[0] = { plugin: nm, patchIndex: i, find: displayFind, issue: "MULTIPLE_MATCH", severity: "warning", moduleCount, details: `Find string matches ${moduleCount}+ modules` };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, 100);
                    issues.push(issue);
                }
            } else {
                stats.validPatches++;
                if (showValid) {
                    const issue: typeof issues[0] = { plugin: nm, patchIndex: i, find: displayFind, issue: "OK", severity: "info", moduleCount: 1 };
                    if (usesIntl && canonFind !== rawFind) issue.canonicalizedFind = canonFind.slice(0, 100);
                    issues.push(issue);
                }
            }
        }

        return { stats, issueCount: stats.noMatch + stats.multiMatch, issues: issues.slice(0, 100) };
    }

    if (action === "lint") {
        if (!findStr) return { error: true, message: "find required for lint" };

        const matchPattern = args.match as string | undefined;

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

            const minifiedMatches = pattern.match(MINIFIED_VARS);
            if (minifiedMatches && !pattern.includes("\\i")) {
                errors.push(`Hardcoded minified vars: ${[...new Set(minifiedMatches)].join(", ")}, use \\i`);
                score -= 3;
            }

            for (const forbidden of FORBIDDEN_PATTERNS) {
                if (forbidden.test(pattern)) {
                    errors.push(`Forbidden pattern: ${forbidden.source}`);
                    score -= 2;
                }
            }

            if (isFind && pattern.length < 20 && !pattern.includes("#{intl::")) {
                warnings.push("Find string < 20 chars, may not be unique");
                score -= 1;
            }

            if (/\b(function|return|if|for|while|const|let)\b/.test(pattern) && !pattern.includes("\\i")) {
                warnings.push("Anchored on generic keywords");
                score -= 2;
            }

            if (/\.\+\??|\.\*\??/.test(pattern) && !/\.\{/.test(pattern)) {
                warnings.push("Uses unbounded wildcards, prefer .{0,N}");
                score -= 1;
            }

            if (pattern.length > 200) { warnings.push("Pattern > 200 chars, consider shorter anchor"); score -= 1; }

            let captures = 0;
            for (let i = 0; i < pattern.length - 1; i++) {
                if (pattern[i] === "(" && pattern[i + 1] !== "?") captures++;
            }
            if (captures > 3) { warnings.push(`${captures} capture groups, max 3 recommended`); score -= 1; }
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
            allErrors.push("Find string matches no modules");
            findAnalysis.score = Math.max(1, findAnalysis.score - 5);
        } else if (moduleIds.length > 1) {
            allWarnings.push(`Find string matches ${moduleIds.length} modules, not unique`);
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

    return { error: true, message: "action: unique (with str), plugin (with pluginName), analyze, lint (with find). For testing patches use testPatch tool." };
}
