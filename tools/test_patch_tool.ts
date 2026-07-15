/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { AnchorInfo, FindModuleMatch, MatchDiagnostic, RegexWarning, TestPatchToolArgs, ToolResult } from "../types";
import {
    ANCHOR_TYPE_ORDER,
    CONTEXT,
    ENUM_MEMBER_RE,
    FUNC_CALL_RE,
    IDENT_ASSIGN_RE,
    INTL_HASH_FULL_RE,
    JS_RESERVED_KEYWORDS,
    LIMITS,
    NOISE_STRINGS,
    PROP_ASSIGN_RE,
    STORE_NAME_RE,
    STRING_LITERAL_RE,
} from "./constants";
import * as u from "./utils";

function findModules(locate: (src: string) => number, limit: number): FindModuleMatch[] {
    const matches: FindModuleMatch[] = [];
    for (const id of u.getModuleIds()) {
        if (matches.length >= limit) break;
        const source = u.getModuleSource(id);
        const matchIdx = locate(source);
        if (matchIdx === -1) continue;
        matches.push({ id, snippet: u.snippet(source, matchIdx, 0, CONTEXT.FIND_SNIPPET_BEFORE, CONTEXT.FIND_SNIPPET_AFTER) });
    }
    return matches;
}

const CATASTROPHIC_BACKTRACKING_RE = /\([^)]*[*+][^)]*\)[*+]/;

function analyzeRegex(pattern: string): RegexWarning[] {
    const warnings: RegexWarning[] = [];
    const loc = (m: RegExpExecArray, pad = 15) => pattern.substring(Math.max(0, m.index - pad), m.index + m[0].length + pad);

    const nested = CATASTROPHIC_BACKTRACKING_RE.exec(pattern);
    if (nested) {
        warnings.push({
            rule: "catastrophicBacktracking",
            severity: "error",
            detail: `Nested unbounded quantifier "${nested[0]}" can cause catastrophic backtracking and freeze the client. Rewrite with a bounded .{0,N} or remove the outer quantifier`,
            location: loc(nested),
        });
    }

    const unbounded = /\.\+\?|\.\*\?/g;
    let m: RegExpExecArray | null;
    while ((m = unbounded.exec(pattern))) {
        warnings.push({
            rule: "unboundedGap",
            severity: "error",
            detail: `"${m[0]}" at ${m.index}, use .{0,N}`,
            location: loc(m),
        });
    }

    const bigRange = /\.\{(\d+),(\d+)\}/g;
    while ((m = bigRange.exec(pattern))) {
        const upper = parseInt(m[2]);
        if (upper > LIMITS.TEST_PATCH.EXCESSIVE_RANGE_WARN) {
            warnings.push({
                rule: "excessiveRange",
                severity: upper > LIMITS.TEST_PATCH.EXCESSIVE_RANGE_ERROR ? "error" : "warning",
                detail: `.{${m[1]},${m[2]}} spans ${upper} chars, tighten anchors`,
                location: loc(m),
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
                location: m[0].slice(0, LIMITS.TEST_PATCH.LOCATION_SLICE),
            });
        }
        const rangeMatch = content.match(/\.\{\d+,(\d+)\}/);
        if (rangeMatch && parseInt(rangeMatch[1]) > LIMITS.TEST_PATCH.LARGE_LOOKBEHIND) {
            warnings.push({
                rule: "largeLookbehind",
                severity: "warning",
                detail: `Lookbehind .{0,${rangeMatch[1]}} is slow, keep short`,
                location: m[0].slice(0, LIMITS.TEST_PATCH.LOCATION_SLICE),
            });
        }
    }

    const captures = u.countUnescapedCaptures(pattern);
    if (captures > LIMITS.TEST_PATCH.MAX_CAPTURES) {
        warnings.push({
            rule: "tooManyCaptures",
            severity: "warning",
            detail: `${captures} captures, max ${LIMITS.TEST_PATCH.MAX_CAPTURES}`,
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
                location: loc(m, 10),
            });
        }
    }

    if (pattern.length > LIMITS.TEST_PATCH.MAX_PATTERN_LENGTH) {
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
        const err = u.checkJsSyntax(source.replace(regex, replaceStr));
        return err ? [{ rule: "syntaxError", severity: "error", detail: err.slice(0, LIMITS.TEST_PATCH.SYNTAX_ERROR_SLICE) }] : [];
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
        .filter(s => s.length >= LIMITS.TEST_PATCH.LITERAL_MIN_LEN);

    const found: string[] = [];
    const missing: string[] = [];
    for (const lit of literals) {
        if (source.includes(lit)) found.push(lit.slice(0, LIMITS.TEST_PATCH.LITERAL_SLICE));
        else missing.push(lit.slice(0, LIMITS.TEST_PATCH.LITERAL_SLICE));
    }

    if (missing.length) {
        return {
            reason: "Literal fragments not in module",
            partialMatch: found.length ? `Found: ${found.slice(0, LIMITS.TEST_PATCH.SAMPLE_PREVIEW).join(", ")}` : undefined,
            suggestion: `Missing: ${missing.slice(0, LIMITS.TEST_PATCH.SAMPLE_PREVIEW).join(", ")}`,
        };
    }

    return {
        reason: "Pattern does not match source",
        suggestion: "Use findContext to rebuild match",
    };
}

function computeScore(warnings: RegexWarning[], findUnique: boolean, matchWorks: boolean): number {
    let score = LIMITS.TEST_PATCH.SCORE_MAX;

    if (!findUnique) score -= LIMITS.TEST_PATCH.SCORE_PENALTY_NOT_UNIQUE;
    if (!matchWorks) score -= LIMITS.TEST_PATCH.SCORE_PENALTY_NO_MATCH;

    for (const w of warnings) {
        if (w.severity === "error") score -= LIMITS.TEST_PATCH.SCORE_PENALTY_ERROR;
        else if (w.severity === "warning") score -= LIMITS.TEST_PATCH.SCORE_PENALTY_WARNING;
    }

    return Math.max(0, score);
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
        const unique = u.countModuleMatches(raw, 3) === 1;
        anchors.push({ anchor: display, type, unique, distance });
    };

    for (const { hash, key, index } of u.iterIntlHashes(region)) {
        const display = u.intlFind(hash, key);
        add(canonicalizeMatch(display), display, "intl", index);
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

export async function handleTestPatch(args: TestPatchToolArgs): Promise<ToolResult> {
    const { find: rawFind, match: matchPattern, replace: replaceStr } = args;

    if (!rawFind || rawFind.length < 3) return { error: true, message: "find required (min 3 chars)" };
    if (!matchPattern) return u.missingArg("match");

    const findWarnings: RegexWarning[] = [];
    const rawKeyMisuse = rawFind.match(/#\{intl::([^}]+)::raw\}/);
    if (rawKeyMisuse && (!INTL_HASH_FULL_RE.test(rawKeyMisuse[1]) || /^[A-Z][A-Z_]+$/.test(rawKeyMisuse[1]))) {
        findWarnings.push({ rule: "rawGivenKeyName", severity: "warning", detail: `"${rawKeyMisuse[1]}::raw" looks like a key name, not a 6-char hash. Drop ::raw so "${rawKeyMisuse[1]}" resolves to its hash and matches.` });
    }

    const findStr = canonicalizeMatch(rawFind);
    let findRegex: RegExp | null = null;
    if (findStr.startsWith("(?:")) { try { findRegex = new RegExp(findStr); } catch {} }
    const locateFind = (src: string) => findRegex ? src.search(findRegex) : src.indexOf(findStr);
    const moduleMatches = findModules(locateFind, 6);
    const findUnique = moduleMatches.length === 1;
    const targetModule = moduleMatches[0] ? u.getModuleSource(moduleMatches[0].id) : null;
    const targetModuleId = moduleMatches[0]?.id ?? null;

    let regex: RegExp;
    try {
        regex = u.buildPatchRegex(matchPattern);
    } catch {
        u.mcpLogger.warn(`testPatch: invalid match regex "${matchPattern.slice(0, LIMITS.TEST_PATCH.INVALID_MATCH_SLICE)}"`);
        return { error: true, message: `Invalid match regex: ${matchPattern}` };
    }

    const canonicalizedRegex = `/${regex.source}/${regex.flags}`;
    const regexWarnings = u.parseRegex(matchPattern) ? analyzeRegex(matchPattern) : [];
    const unsafePattern = regexWarnings.some(w => w.rule === "catastrophicBacktracking");

    let matchWorks = false;
    let matchedText: string | null = null;
    let captureGroups = 0;
    let matchIndex: number | null = null;
    let matchContext: string | null = null;
    let replacementPreview: string | null = null;
    let replaceNoop = false;
    const matchWarnings: RegexWarning[] = [];
    let replaceWarnings: RegexWarning[] = [];
    let diagnostic: MatchDiagnostic | null = null;

    if (targetModule && !unsafePattern) {
        const firstHit = targetModule.match(u.stripGlobal(regex));
        if (firstHit && firstHit.index !== undefined) {
            matchWorks = true;
            matchIndex = firstHit.index;
            matchedText = firstHit[0].slice(0, CONTEXT.MATCHED_TEXT_MAX);
            captureGroups = firstHit.length - 1;
            matchContext = u.snippet(targetModule, matchIndex, firstHit[0].length, CONTEXT.MATCH_CONTEXT_PAD, CONTEXT.MATCH_CONTEXT_PAD);
            if (matchedText === "") {
                matchWarnings.push({ rule: "zeroWidthMatch", severity: "warning", detail: "Zero-width match: the replacement is inserted, not substituted. Confirm this is an intentional lookaround anchor, not an unanchored or empty pattern." });
            }
            if (replaceStr != null) {
                replaceWarnings = validateReplace(replaceStr, captureGroups, regex.source);
                const replacedSource = targetModule.replace(regex, replaceStr);
                replaceNoop = replacedSource === targetModule;
                if (replaceNoop) {
                    replaceWarnings.push({ rule: "replaceNoop", severity: "error", detail: "Replacement did not change the source." });
                }
                replacementPreview = u.snippet(replacedSource, matchIndex, replaceStr.length || 50, CONTEXT.REPLACEMENT_BEFORE, CONTEXT.REPLACEMENT_AFTER);
                replaceWarnings.push(...checkSyntaxAfterReplace(targetModule, regex, replaceStr));
            }
        } else {
            diagnostic = diagnoseMatchFailure(targetModule, regex);
        }
    }

    const allWarnings = [...findWarnings, ...regexWarnings, ...matchWarnings, ...replaceWarnings];
    const score = computeScore(allWarnings, findUnique, matchWorks);

    let verdict: string;
    if (moduleMatches.length === 0) verdict = "FIND_NO_MATCH";
    else if (!findUnique) verdict = "FIND_NOT_UNIQUE";
    else if (unsafePattern) verdict = "UNSAFE_PATTERN";
    else if (!matchWorks) verdict = "MATCH_FAILED";
    else if (replaceNoop) verdict = "REPLACE_NOOP";
    else if (allWarnings.some(w => w.severity === "error")) verdict = "PASS_WITH_ERRORS";
    else if (allWarnings.some(w => w.severity === "warning")) verdict = "PASS_WITH_WARNINGS";
    else verdict = "PASS";

    let findContext: string | undefined;
    let nearbyAnchors: AnchorInfo[] | undefined;
    let suggestedFinds: string[] | undefined;
    if (targetModule) {
        const findIdx = locateFind(targetModule);
        if (findIdx !== -1) {
            findContext = u.snippet(targetModule, findIdx, 0, CONTEXT.FIND_CONTEXT_BEFORE, CONTEXT.FIND_CONTEXT_AFTER);
            nearbyAnchors = discoverAnchors(targetModule, findIdx, CONTEXT.ANCHOR_RADIUS);

            if (!findUnique && nearbyAnchors.length) {
                const combos = nearbyAnchors.filter(a => a.unique).slice(0, 3).map(a => a.anchor);
                if (!combos.length) {
                    const toSearch = (x: AnchorInfo): string => x.anchor.startsWith("#{intl::") ? canonicalizeMatch(x.anchor) : x.anchor.replace(/^"|"$/g, "");
                    const modulesFor = (s: string) => u.batchCountModuleMatches([s], 3).get(s)?.moduleIds ?? [];
                    for (let i = 0; i < nearbyAnchors.length && combos.length < 3; i++) {
                        const a = nearbyAnchors[i];
                        const idsA = modulesFor(toSearch(a));
                        for (let j = i + 1; j < nearbyAnchors.length; j++) {
                            const b = nearbyAnchors[j];
                            const idsB = modulesFor(toSearch(b));
                            const shared = idsA.filter(id => idsB.includes(id));
                            if (shared.length === 1) {
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
        multiMatchResults = moduleMatches.slice(0, LIMITS.TEST_PATCH.MULTI_MATCH_SLICE).map(m => {
            const src = u.getModuleSource(m.id);
            const result = src.match(regex);
            return { id: m.id, matchWorks: !!result, matchedText: result?.[0]?.slice(0, LIMITS.TEST_PATCH.LOCATION_SLICE) };
        });
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
        findModules: moduleMatches.slice(0, LIMITS.TEST_PATCH.MULTI_MATCH_SLICE),
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
        suggestedFinds,
        multiMatchResults,
    };
}
