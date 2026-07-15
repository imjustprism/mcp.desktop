/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type MatchFailureKind =
    | "matches"
    | "gap-too-narrow"
    | "lookaround-stale"
    | "literals-missing"
    | "structure-changed";

export interface MatchRepair {
    readonly status: "matches" | "repaired" | "unrepaired";
    readonly failureKind: MatchFailureKind;
    readonly adjustedPattern?: string;
    readonly adjustmentNote?: string;
    readonly foundLiterals: readonly string[];
    readonly missingLiterals: readonly string[];
    readonly matchIndex?: number;
}

const IDENT_CLASS = "(?:[A-Za-z_$][\\w$]*)";
const MAX_GAP = 1000;
const MINIMIZE_SLACK = 10;
const MIN_LITERAL_LEN = 4;
const MAX_REPAIR_QUANTS = 8;
const MAX_WIDEN_STEPS = 200_000;
const MULTI_WIDEN_BUDGET = 50_000_000;
const ESCAPED_LITERALS = new Set([..."^$.|?*+()[]{}\\/-"]);
const META = new Set([..."\\^$.|?*+()[]{}"]);

function expandMinifiedIdent(pattern: string): string {
    let out = "";
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === "\\" && pattern[i + 1] === "i") { out += IDENT_CLASS; i += 2; }
        else if (pattern[i] === "\\") { out += pattern[i] + (pattern[i + 1] ?? ""); i += 2; }
        else { out += pattern[i]; i++; }
    }
    return out;
}

function firstMatchIndex(pattern: string, flags: string, source: string): number {
    let re: RegExp;
    try {
        re = new RegExp(expandMinifiedIdent(pattern), flags.replace("g", ""));
    } catch {
        return -2;
    }
    const m = re.exec(source);
    return m ? m.index : -1;
}

function countMatches(pattern: string, flags: string, source: string, cap: number): number {
    let re: RegExp;
    try {
        re = new RegExp(expandMinifiedIdent(pattern), flags.replace("g", "") + "g");
    } catch {
        return -1;
    }
    let n = 0;
    for (let m = re.exec(source); m && n < cap; m = re.exec(source)) {
        n++;
        if (m.index === re.lastIndex) re.lastIndex++;
    }
    return n;
}

interface Quantifier {
    readonly start: number;
    readonly end: number;
    readonly lo: number;
    readonly hi: number;
}

function findBoundedQuantifiers(pattern: string): Quantifier[] {
    const out: Quantifier[] = [];
    let i = 0;
    let inClass = false;
    let prevAtomGroupLike = false;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === "\\") { prevAtomGroupLike = pattern[i + 1] === "i"; i += 2; continue; }
        if (inClass) { if (c === "]") { inClass = false; prevAtomGroupLike = false; } i++; continue; }
        if (c === "[") { inClass = true; i++; continue; }
        if (c === "{") {
            const m = /^\{(\d+),(\d+)\}/.exec(pattern.slice(i));
            if (m) {
                if (!prevAtomGroupLike) out.push({ start: i, end: i + m[0].length, lo: Number(m[1]), hi: Number(m[2]) });
                i += m[0].length;
                prevAtomGroupLike = false;
                continue;
            }
        }
        prevAtomGroupLike = c === ")";
        i++;
    }
    return out;
}

function withQuantifierHighs(pattern: string, quants: readonly Quantifier[], highs: readonly number[]): string {
    let result = "";
    let prev = 0;
    for (let k = 0; k < quants.length; k++) {
        result += pattern.slice(prev, quants[k].start) + `{${quants[k].lo},${highs[k]}}`;
        prev = quants[k].end;
    }
    return result + pattern.slice(prev);
}

function repairByWidening(source: string, pattern: string, flags: string): { pattern: string; index: number; note: string } | null {
    const quants = findBoundedQuantifiers(pattern);
    if (!quants.length || quants.length > MAX_REPAIR_QUANTS) return null;

    const original = quants.map(q => q.hi);
    for (let k = 0; k < quants.length; k++) {
        let otherRange = 1;
        for (let j = 0; j < quants.length; j++) if (j !== k) otherRange *= quants[j].hi - quants[j].lo + 1;
        if (MAX_GAP * otherRange > MAX_WIDEN_STEPS) continue;

        const probe = original.slice();
        probe[k] = MAX_GAP;
        if (firstMatchIndex(withQuantifierHighs(pattern, quants, probe), flags, source) < 0) continue;

        let lo = quants[k].hi;
        let hi = MAX_GAP;
        let best = MAX_GAP;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const trial = original.slice();
            trial[k] = mid;
            if (firstMatchIndex(withQuantifierHighs(pattern, quants, trial), flags, source) >= 0) { best = mid; hi = mid - 1; }
            else lo = mid + 1;
        }
        const finalHighs = original.slice();
        finalHighs[k] = Math.min(best + MINIMIZE_SLACK, MAX_GAP);
        const finalPattern = withQuantifierHighs(pattern, quants, finalHighs);
        const index = firstMatchIndex(finalPattern, flags, source);
        if (index >= 0) return { pattern: finalPattern, index, note: "widened a bounded gap to the minimum that still matches" };
    }
    return quants.length >= 2 ? repairByMultiWidening(source, pattern, flags, quants) : null;
}

function repairByMultiWidening(source: string, pattern: string, flags: string, quants: readonly Quantifier[]): { pattern: string; index: number; note: string } | null {
    const product = Math.max(1, Math.floor(MULTI_WIDEN_BUDGET / Math.max(source.length, 1)));
    const uniform = Math.min(MAX_GAP, Math.floor(Math.pow(product, 1 / quants.length)) - 1);
    const floor = Math.max(...quants.map(q => q.hi));
    if (uniform <= floor) return null;

    const highsAt = (u: number) => quants.map(q => Math.max(q.hi, u));
    if (firstMatchIndex(withQuantifierHighs(pattern, quants, highsAt(uniform)), flags, source) < 0) return null;

    let lo = floor + 1;
    let hi = uniform;
    let best = uniform;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (firstMatchIndex(withQuantifierHighs(pattern, quants, highsAt(mid)), flags, source) >= 0) { best = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    const finalPattern = withQuantifierHighs(pattern, quants, highsAt(Math.min(best + MINIMIZE_SLACK, uniform)));
    const index = firstMatchIndex(finalPattern, flags, source);
    if (index >= 0) return { pattern: finalPattern, index, note: "widened several bounded gaps to a uniform minimum that still matches" };
    return null;
}

interface Lookaround {
    readonly start: number;
    readonly end: number;
    readonly kind: "lookbehind" | "lookahead";
}

function findLookarounds(pattern: string): Lookaround[] {
    const out: Lookaround[] = [];
    let inClassOuter = false;
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === "\\") { i++; continue; }
        if (inClassOuter) { if (pattern[i] === "]") inClassOuter = false; continue; }
        if (pattern[i] === "[") { inClassOuter = true; continue; }
        if (pattern[i] !== "(" || pattern[i + 1] !== "?") continue;
        const c2 = pattern[i + 2];
        const c3 = pattern[i + 3];
        let kind: Lookaround["kind"] | null = null;
        if (c2 === "=" || c2 === "!") kind = "lookahead";
        else if (c2 === "<" && (c3 === "=" || c3 === "!")) kind = "lookbehind";
        if (!kind) continue;
        let depth = 0;
        let j = i;
        let inClass = false;
        for (; j < pattern.length; j++) {
            if (pattern[j] === "\\") { j++; continue; }
            if (inClass) { if (pattern[j] === "]") inClass = false; continue; }
            if (pattern[j] === "[") { inClass = true; continue; }
            if (pattern[j] === "(") depth++;
            else if (pattern[j] === ")") { depth--; if (depth === 0) break; }
        }
        out.push({ start: i, end: j + 1, kind });
    }
    return out;
}

function hasLiteralAnchor(pattern: string): boolean {
    return literalRuns(pattern, 2).length > 0;
}

function hasCapturingGroup(pattern: string): boolean {
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") { i++; continue; }
        if (inClass) { if (c === "]") inClass = false; continue; }
        if (c === "[") { inClass = true; continue; }
        if (c === "(" && pattern[i + 1] !== "?") return true;
    }
    return false;
}

function repairByStripping(source: string, pattern: string, flags: string): { pattern: string; index: number; note: string } | null {
    const las = findLookarounds(pattern);
    let candidate = pattern;
    let removed = 0;
    for (let k = las.length - 1; k >= 0; k--) {
        if (hasCapturingGroup(pattern.slice(las[k].start, las[k].end))) return null;
        candidate = candidate.slice(0, las[k].start) + candidate.slice(las[k].end);
        removed++;
        const index = firstMatchIndex(candidate, flags, source);
        if (index < 0 || !hasLiteralAnchor(candidate)) continue;
        if (countMatches(candidate, flags, source, 2) !== 1) return null;
        const note = removed > 1
            ? `removed ${removed} stale lookarounds that no longer hold`
            : `removed a stale ${las[k].kind} that no longer holds`;
        return { pattern: candidate, index, note };
    }
    return null;
}

export function literalRuns(pattern: string, minLen: number): string[] {
    const runs: string[] = [];
    let cur = "";
    let i = 0;
    const flush = () => { if (cur.length >= minLen) runs.push(cur); cur = ""; };
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === "\\") {
            const nx = pattern[i + 1];
            if (nx !== undefined && ESCAPED_LITERALS.has(nx)) { cur += nx; i += 2; continue; }
            flush();
            i += 2;
            continue;
        }
        if (c === "[") {
            flush();
            i++;
            while (i < pattern.length && pattern[i] !== "]") { if (pattern[i] === "\\") i++; i++; }
            i++;
            continue;
        }
        if (c === "(") {
            flush();
            i++;
            if (pattern[i] === "?") { i++; if (pattern[i] === "<") i++; if (pattern[i] === "=" || pattern[i] === "!" || pattern[i] === ":") i++; }
            continue;
        }
        if (c === "{") {
            const m = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
            flush();
            i += m ? m[0].length : 1;
            continue;
        }
        if (META.has(c)) { flush(); i++; continue; }
        cur += c;
        i++;
    }
    flush();
    return runs;
}

function splitLiterals(pattern: string, source: string): { found: string[]; missing: string[] } {
    const found: string[] = [];
    const missing: string[] = [];
    for (const r of literalRuns(pattern, MIN_LITERAL_LEN)) (source.includes(r) ? found : missing).push(r);
    return { found, missing };
}

export function diagnoseMatch(source: string, pattern: string, flags = ""): MatchRepair {
    const { found, missing } = splitLiterals(pattern, source);
    const base = { foundLiterals: found, missingLiterals: missing };

    const direct = firstMatchIndex(pattern, flags, source);
    if (direct >= 0) return { status: "matches", failureKind: "matches", matchIndex: direct, ...base };

    const widened = repairByWidening(source, pattern, flags);
    if (widened) return { status: "repaired", failureKind: "gap-too-narrow", adjustedPattern: widened.pattern, adjustmentNote: widened.note, matchIndex: widened.index, ...base };

    const stripped = repairByStripping(source, pattern, flags);
    if (stripped) return { status: "repaired", failureKind: "lookaround-stale", adjustedPattern: stripped.pattern, adjustmentNote: stripped.note, matchIndex: stripped.index, ...base };

    if (missing.length) return { status: "unrepaired", failureKind: "literals-missing", ...base };
    return { status: "unrepaired", failureKind: "structure-changed", ...base };
}
