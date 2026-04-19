/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { AnchorInfo, FindModuleMatch, MatchDiagnostic, RegexWarning, TestPatchToolArgs } from "../types";
import {
    ANCHOR_TYPE_ORDER,
    CONTEXT,
    createIntlHashBracketRegex,
    createIntlHashDotRegex,
    ENUM_MEMBER_RE,
    FUNC_CALL_RE,
    IDENT_ASSIGN_RE,
    JS_RESERVED_KEYWORDS,
    NOISE_STRINGS,
    PROP_ASSIGN_RE,
    STORE_NAME_RE,
    STRING_LITERAL_RE,
} from "./constants";
import * as u from "./utils";

function findModules(findStr: string, findRegex: RegExp | null, limit: number): FindModuleMatch[] {
    const matches: FindModuleMatch[] = [];
    for (const id of u.getModuleIds()) {
        if (matches.length >= limit) break;
        const source = u.getModuleSource(id);
        const matchIdx = findRegex ? source.search(findRegex) : source.indexOf(findStr);
        if (matchIdx === -1) continue;
        const start = Math.max(0, matchIdx - CONTEXT.FIND_SNIPPET_BEFORE);
        const end = Math.min(source.length, matchIdx + CONTEXT.FIND_SNIPPET_AFTER);
        matches.push({ id, snippet: source.slice(start, end) });
    }
    return matches;
}

function analyzeRegex(pattern: string): RegexWarning[] {
    const warnings: RegexWarning[] = [];

    const unbounded = /\.\+\?|\.\*\?/g;
    let m: RegExpExecArray | null;
    while ((m = unbounded.exec(pattern))) {
        warnings.push({
            rule: "unboundedGap",
            severity: "error",
            detail: `"${m[0]}" at ${m.index}, use .{0,N}`,
            location: pattern.substring(Math.max(0, m.index - 15), m.index + m[0].length + 15),
        });
    }

    const bigRange = /\.\{(\d+),(\d+)\}/g;
    while ((m = bigRange.exec(pattern))) {
        const upper = parseInt(m[2]);
        if (upper > 200) {
            warnings.push({
                rule: "excessiveRange",
                severity: upper > 500 ? "error" : "warning",
                detail: `.{${m[1]},${m[2]}} spans ${upper} chars, tighten anchors`,
                location: pattern.substring(Math.max(0, m.index - 15), m.index + m[0].length + 15),
            });
        }
    }

    const lookbehinds = /\(\?<[!=]([^)]*(?:\([^)]*\))*[^)]*)\)/g;
    while ((m = lookbehinds.exec(pattern))) {
        const content = m[1];
        if (/\.\+\?|\.\*\?/.test(content)) {
            warnings.push({
                rule: "unboundedLookbehind",
                severity: "error",
                detail: "Lookbehind has unbounded .+?/.*?, slow and fragile",
                location: m[0].slice(0, 80),
            });
        }
        if (/\.\{\d+,(\d+)\}/.test(content)) {
            const rangeMatch = content.match(/\.\{\d+,(\d+)\}/);
            if (rangeMatch && parseInt(rangeMatch[1]) > 100) {
                warnings.push({
                    rule: "largeLookbehind",
                    severity: "warning",
                    detail: `Lookbehind .{0,${rangeMatch[1]}} is slow, keep short`,
                    location: m[0].slice(0, 80),
                });
            }
        }
    }

    const captures = u.countUnescapedCaptures(pattern);
    if (captures > 4) {
        warnings.push({
            rule: "tooManyCaptures",
            severity: "warning",
            detail: `${captures} captures, max 3`,
        });
    }

    const minified = /(?:^|[^\\])(?:\\i\\\.\\i)(?:\s|$|[,;)])/g;
    while ((m = minified.exec(pattern))) {
        const before = pattern.substring(Math.max(0, m.index - 20), m.index);
        const after = pattern.substring(m.index + m[0].length, m.index + m[0].length + 20);
        if (!before.match(/[a-zA-Z"':.]$/) && !after.match(/^[a-zA-Z"':]/)) {
            warnings.push({
                rule: "isolatedMinifiedChain",
                severity: "warning",
                detail: "\\i\\.\\i alone is fragile, add stable anchors",
                location: pattern.substring(Math.max(0, m.index - 10), m.index + m[0].length + 10),
            });
        }
    }

    if (pattern.length > 300) {
        warnings.push({
            rule: "longPattern",
            severity: "info",
            detail: `${pattern.length} chars, consider simplifying`,
        });
    }

    return warnings;
}

function validateReplace(replaceStr: string, captureCount: number, matchSource = ""): RegexWarning[] {
    const warnings: RegexWarning[] = [];
    const referenced = new Set<number>();
    for (const m of replaceStr.matchAll(/\$(\d+)/g)) {
        const ref = parseInt(m[1]);
        referenced.add(ref);
        if (ref > captureCount || ref < 1) {
            warnings.push({
                rule: "invalidCaptureRef",
                severity: "error",
                detail: `$${ref} but only ${captureCount} capture${captureCount !== 1 ? "s" : ""}`,
            });
        }
    }
    for (let i = 1; i <= captureCount; i++) {
        if (!referenced.has(i)) {
            warnings.push({ rule: "unusedCapture", severity: "info", detail: `Capture $${i} never referenced in replace` });
        }
    }
    if (matchSource) {
        const names = u.extractCaptureNames(matchSource);
        for (const m of replaceStr.matchAll(/\$<([A-Za-z_$][\w$]*)>/g)) {
            if (!names.includes(m[1])) {
                warnings.push({ rule: "invalidNamedRef", severity: "error", detail: `$<${m[1]}> references unknown named group` });
            }
        }
    }
    return warnings;
}

function checkSyntaxAfterReplace(source: string, regex: RegExp, replaceStr: string): RegexWarning[] {
    try {
        const replaced = source.replace(regex, replaceStr);
        try { new Function(replaced); return []; }
        catch (e) {
            const warning: RegexWarning = { rule: "syntaxError", severity: "error", detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
            return [warning];
        }
    } catch { return []; }
}

function diagnoseMatchFailure(source: string, regex: RegExp): MatchDiagnostic {
    const src = regex.source;
    const { flags } = regex;

    const tryVariant = (mutated: string): boolean => {
        if (mutated === src) return false;
        return u.safeCall(() => new RegExp(mutated, flags).test(source), false);
    };

    const ranges = [...src.matchAll(/\.\{(\d+),(\d+)\}/g)];
    if (ranges.length) {
        const widened = src.replace(/\.\{(\d+),(\d+)\}/g, (_, lo, hi) => `.{${lo},${Math.max(parseInt(hi) * 2, parseInt(hi) + 500)}}`);
        if (tryVariant(widened)) {
            return { reason: "Range too narrow", suggestion: `Widen ${ranges.map(r => `.{${r[1]},${r[2]}}`).join(", ")}` };
        }
    }

    if (tryVariant(src.replace(/\(\?<[!=](?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/g, ""))) {
        return { reason: "Lookbehind prevents match", suggestion: "Check context before match target" };
    }

    if (tryVariant(src.replace(/\(\?[=!](?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/g, ""))) {
        return { reason: "Lookahead prevents match", suggestion: "Check context after match target" };
    }

    const literals = src
        .replace(/\(\?[<!=:][^)]*\)/g, "")
        .replace(/\[(?:[^\]\\]|\\.)*\]/g, "")
        .split(/[.+*?{}()|\\[\]^$]+/)
        .filter(s => s.length >= 4);

    const found: string[] = [];
    const missing: string[] = [];
    for (const lit of literals) {
        if (source.includes(lit)) found.push(lit.slice(0, 40));
        else missing.push(lit.slice(0, 40));
    }

    if (missing.length) {
        return {
            reason: "Literal fragments not in module",
            partialMatch: found.length ? `Found: ${found.slice(0, 3).join(", ")}` : undefined,
            suggestion: `Missing: ${missing.slice(0, 3).join(", ")}`,
        };
    }

    return {
        reason: "Pattern does not match source",
        suggestion: "Use findContext to rebuild match",
    };
}

function computeScore(regexWarnings: RegexWarning[], replaceWarnings: RegexWarning[], findUnique: boolean, matchWorks: boolean): number {
    let score = 10;

    if (!findUnique) score -= 4;
    if (!matchWorks) score -= 5;

    for (const w of [...regexWarnings, ...replaceWarnings]) {
        if (w.severity === "error") score -= 3;
        else if (w.severity === "warning") score -= 1;
    }

    return Math.max(0, Math.min(10, score));
}

function discoverAnchors(source: string, centerIdx: number, radius: number): AnchorInfo[] {
    const start = Math.max(0, centerIdx - radius);
    const end = Math.min(source.length, centerIdx + radius);
    const region = source.slice(start, end);
    const anchors: AnchorInfo[] = [];
    const seen = new Set<string>();

    const add = (raw: string, display: string, type: string, regionIdx: number) => {
        if (seen.has(display) || display.length < 6) return;
        seen.add(display);
        const absIdx = start + regionIdx;
        const distance = Math.abs(absIdx - centerIdx);
        const unique = u.countModuleMatchesFast(raw, 3) === 1;
        anchors.push({ anchor: display, type, unique, distance });
    };

    for (const regex of [createIntlHashDotRegex(), createIntlHashBracketRegex()]) {
        let m: RegExpExecArray | null;
        while ((m = regex.exec(region))) {
            const hash = m[1];
            const key = u.getIntlKeyFromHash(hash);
            const display = key ? `#{intl::${key}}` : `#{intl::${hash}::raw}`;
            const searchStr = canonicalizeMatch(display);
            add(searchStr, display, "intl", m.index);
        }
    }

    const anchorScans: Array<{ regex: RegExp; extract: (m: RegExpExecArray) => { find: string; search: string; type: string } | null }> = [
        { regex: STORE_NAME_RE(), extract: m => ({ find: `="${m[1]}"`, search: `="${m[1]}"`, type: "storeName" }) },
        {
            regex: STRING_LITERAL_RE(),
            extract: m => {
                if (NOISE_STRINGS.has(m[1]) || !/^[a-zA-Z][a-zA-Z0-9_./ -]{4,}$/.test(m[1])) return null;
                return { find: m[1], search: `"${m[1]}"`, type: m[1].includes(" ") ? "errorString" : "string" };
            },
        },
        { regex: FUNC_CALL_RE(), extract: m => (JS_RESERVED_KEYWORDS.has(m[1]) ? null : { find: `.${m[1]}(`, search: `.${m[1]}(`, type: "funcCall" }) },
        { regex: ENUM_MEMBER_RE(), extract: m => ({ find: `.${m[1]}`, search: `.${m[1]}`, type: "enum" }) },
        { regex: IDENT_ASSIGN_RE(), extract: m => ({ find: m[1], search: m[1], type: "ident" }) },
        { regex: PROP_ASSIGN_RE(), extract: m => ({ find: `${m[1]}:`, search: `${m[1]}:`, type: "prop" }) },
    ];

    for (const { regex, extract } of anchorScans) {
        for (const anchor of u.scanSingleOccurrences(region, regex, extract)) {
            add(anchor.search, anchor.find, anchor.type, anchor.index);
        }
    }

    anchors.sort((a, b) => {
        const typeComp = u.compareByAnchorType(a, b, ANCHOR_TYPE_ORDER);
        return typeComp || a.distance - b.distance;
    });

    return anchors.slice(0, CONTEXT.MAX_ANCHORS);
}

export async function handleTestPatchTool(args: TestPatchToolArgs): Promise<unknown> {
    const { find: rawFind, match: matchPattern, replace: replaceStr } = args;

    if (!rawFind || rawFind.length < 3) return { error: true, message: "find required (min 3 chars)" };
    if (!matchPattern) return u.missingArg("match");

    const findStr = canonicalizeMatch(rawFind);
    const findRegex = typeof findStr === "string" && findStr.startsWith("(?:") ? new RegExp(findStr) : null;
    const moduleMatches = findModules(findStr, findRegex, 6);
    const findUnique = moduleMatches.length === 1;
    const targetModule = moduleMatches[0] ? u.getModuleSource(moduleMatches[0].id) : null;
    const targetModuleId = moduleMatches[0]?.id ?? null;

    let regex: RegExp;
    try {
        regex = u.buildPatchRegex(matchPattern);
    } catch {
        u.mcpLogger.warn(`testPatch: invalid match regex "${matchPattern.slice(0, 100)}"`);
        return { error: true, message: `Invalid match regex: ${matchPattern}` };
    }

    const canonicalizedRegex = `/${regex.source}/${regex.flags}`;
    const regexWarnings = analyzeRegex(matchPattern);

    let matchWorks = false;
    let matchedText: string | null = null;
    let captureGroups = 0;
    let matchIndex: number | null = null;
    let matchContext: string | null = null;
    let replacementPreview: string | null = null;
    let replaceWarnings: RegexWarning[] = [];
    let diagnostic: MatchDiagnostic | null = null;

    if (targetModule) {
        const firstHit = regex.global
            ? (() => { const r = new RegExp(regex.source, regex.flags.replace("g", "")); return targetModule.match(r); })()
            : targetModule.match(regex);
        matchWorks = !!firstHit;
        matchedText = firstHit?.[0]?.slice(0, CONTEXT.MATCHED_TEXT_MAX) ?? null;
        captureGroups = firstHit ? firstHit.length - 1 : 0;
        matchIndex = firstHit?.index ?? null;

        if (matchWorks && matchIndex !== null) {
            const ctxStart = Math.max(0, matchIndex - CONTEXT.MATCH_CONTEXT_PAD);
            const ctxEnd = Math.min(targetModule.length, matchIndex + firstHit![0].length + CONTEXT.MATCH_CONTEXT_PAD);
            matchContext = targetModule.slice(ctxStart, ctxEnd);
        }

        if (matchWorks && replaceStr != null) {
            replaceWarnings = validateReplace(replaceStr, captureGroups, regex.source);
            if (matchIndex !== null) {
                const replaced = targetModule.replace(regex, replaceStr);
                const start = Math.max(0, matchIndex - CONTEXT.REPLACEMENT_BEFORE);
                const end = Math.min(replaced.length, matchIndex + (replaceStr.length || 50) + CONTEXT.REPLACEMENT_AFTER);
                replacementPreview = replaced.slice(start, end);
                replaceWarnings.push(...checkSyntaxAfterReplace(targetModule, regex, replaceStr));
            }
        }

        if (!matchWorks) {
            diagnostic = diagnoseMatchFailure(targetModule, regex);
        }
    }

    const allWarnings = [...regexWarnings, ...replaceWarnings];
    const score = computeScore(regexWarnings, replaceWarnings, findUnique, matchWorks);

    let verdict: string;
    if (moduleMatches.length === 0) verdict = "FIND_NO_MATCH";
    else if (!findUnique) verdict = "FIND_NOT_UNIQUE";
    else if (!matchWorks) verdict = "MATCH_FAILED";
    else if (allWarnings.some(w => w.severity === "error")) verdict = "PASS_WITH_ERRORS";
    else if (allWarnings.some(w => w.severity === "warning")) verdict = "PASS_WITH_WARNINGS";
    else verdict = "PASS";

    let findContext: string | undefined;
    if (targetModule) {
        const canonFind = findStr;
        const idx = findRegex ? targetModule.search(findRegex) : targetModule.indexOf(canonFind);
        if (idx !== -1) {
            const start = Math.max(0, idx - CONTEXT.FIND_CONTEXT_BEFORE);
            const end = Math.min(targetModule.length, idx + CONTEXT.FIND_CONTEXT_AFTER);
            findContext = targetModule.slice(start, end);
        }
    }

    let nearbyAnchors: AnchorInfo[] | undefined;
    let suggestedFinds: string[] | undefined;
    if (targetModule) {
        const canonFind = findStr;
        const findIdx = findRegex ? targetModule.search(findRegex) : targetModule.indexOf(canonFind);
        if (findIdx !== -1) {
            nearbyAnchors = discoverAnchors(targetModule, findIdx, CONTEXT.ANCHOR_RADIUS);

            if (!findUnique && nearbyAnchors?.length) {
                const combos: string[] = [];
                for (const anchor of nearbyAnchors) {
                    if (anchor.unique && combos.length < 3) {
                        combos.push(anchor.anchor);
                    }
                }
                if (!combos.length) {
                    for (let i = 0; i < nearbyAnchors.length && combos.length < 3; i++) {
                        for (let j = i + 1; j < nearbyAnchors.length; j++) {
                            const a = nearbyAnchors[i],
                                b = nearbyAnchors[j];
                            const aSearch = a.anchor.startsWith("#{intl::") ? canonicalizeMatch(a.anchor) : a.anchor.replace(/^"|"$/g, "");
                            const bSearch = b.anchor.startsWith("#{intl::") ? canonicalizeMatch(b.anchor) : b.anchor.replace(/^"|"$/g, "");
                            const combined = aSearch + "," + bSearch;
                            if (u.countModuleMatchesFast(combined, 3) === 1) {
                                combos.push(`${a.anchor} + ${b.anchor}`);
                                break;
                            }
                        }
                    }
                }
                if (combos.length) suggestedFinds = combos;
            }
        }
    }

    let multiMatchResults: Array<{ id: string; matchWorks: boolean; matchedText?: string }> | undefined;
    if (!findUnique && moduleMatches.length > 1) {
        multiMatchResults = moduleMatches.slice(0, 5).map(m => {
            const src = u.getModuleSource(m.id);
            const result = src.match(regex);
            return { id: m.id, matchWorks: !!result, matchedText: result?.[0]?.slice(0, 80) };
        });
    }

    let benchmarkResult: Record<string, unknown> | undefined;
    if (args.benchmark && matchWorks && targetModule && replaceStr != null) {
        const iters = u.clampIters(args.iterations, 10000);
        const numRounds = u.clampRounds(args.rounds, 3);
        const bench = u.benchmarkReplace(targetModule, regex, replaceStr, iters, numRounds);

        benchmarkResult = {
            coldShotMs: bench.coldMs,
            wouldFlagSlow: bench.wouldFlagSlow,
            iterations: iters,
            rounds: numRounds,
            moduleSize: targetModule.length,
            medianPerOp: bench.medianUs + "μs",
            minPerOp: bench.minUs + "μs",
            roundsPerOp: bench.roundsUs.map(v => v + "μs"),
        };
    }

    return {
        find: rawFind,
        findCanonicalized: findStr !== rawFind ? findStr : undefined,
        match: matchPattern,
        matchCanonicalized: canonicalizedRegex !== matchPattern ? canonicalizedRegex : undefined,
        replace: replaceStr ?? null,
        moduleId: findUnique ? targetModuleId : undefined,
        findUnique,
        findModuleCount: moduleMatches.length,
        findModules: moduleMatches.slice(0, 5),
        matchWorks,
        matchedText,
        matchContext,
        captureGroups,
        replacementPreview,
        score,
        verdict,
        warnings: allWarnings.length ? allWarnings : undefined,
        diagnostic: diagnostic ?? undefined,
        findContext,
        nearbyAnchors: nearbyAnchors?.length ? nearbyAnchors : undefined,
        suggestedFinds: suggestedFinds?.length ? suggestedFinds : undefined,
        multiMatchResults: multiMatchResults?.length ? multiMatchResults : undefined,
        benchmark: benchmarkResult,
    };
}
