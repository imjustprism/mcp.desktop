/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type DurabilityTier, scoreDurability } from "./durability";
import { computeVolatileSpans, detectRequireParam, type Span } from "./genFinds";
import { type Token, tokenize, tokenText } from "./tokenizer";

export interface TokenFind {
    readonly find: string;
    readonly score: number;
    readonly durability: number;
    readonly tier: DurabilityTier;
    readonly reasons: readonly string[];
}

export interface TokenFindsOptions {
    requireParam?: string;
    limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_FIND_LEN = 400;
const MIN_STABLE_IDENT_LEN = 4;
const MAX_RESILIENCE_BONUS = 2;
const DURABILITY_MAX = 10;
const II = "\\i";
const II_EXPANSION = "[A-Za-z_$][\\w$]*";

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function overlapsVolatile(spans: readonly Span[], start: number, end: number): boolean {
    let lo = 0;
    let hi = spans.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid][0] < end) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans >= 0 && spans[ans][1] > start;
}

function isMinifiedIdent(source: string, tokens: readonly Token[], i: number): boolean {
    const t = tokens[i];
    if (t.kind !== "ident") return false;
    if (t.end - t.start >= MIN_STABLE_IDENT_LEN) return false;
    const prev = tokens[i - 1];
    return !(prev?.kind === "punct" && source[prev.start] === ".");
}

function collectRuns(tokens: readonly Token[], spans: readonly Span[]): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    let open = -1;
    for (let i = 0; i <= tokens.length; i++) {
        const inRun = i < tokens.length && !overlapsVolatile(spans, tokens[i].start, tokens[i].end);
        if (inRun) {
            if (open < 0) open = i;
        } else if (open >= 0) {
            runs.push([open, i]);
            open = -1;
        }
    }
    return runs;
}

export function expandIi(pattern: string): string {
    let out = "";
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === "\\" && pattern[i + 1] === "i") { out += II_EXPANSION; i += 2; }
        else if (pattern[i] === "\\") { out += pattern[i] + (pattern[i + 1] ?? ""); i += 2; }
        else { out += pattern[i]; i++; }
    }
    return out;
}

interface RunBuild {
    readonly pattern: string;
    readonly literal: string;
    readonly iiCount: number;
    readonly contentWeight: number;
    readonly hasAnchor: boolean;
}

function buildRun(source: string, tokens: readonly Token[], lo: number, hi: number): RunBuild {
    let pattern = "";
    let literal = "";
    let iiCount = 0;
    let contentWeight = 0;
    let hasAnchor = false;
    let cursor = tokens[lo].start;

    for (let k = lo; k < hi; k++) {
        const t = tokens[k];
        if (t.start > cursor) {
            const gap = source.slice(cursor, t.start);
            pattern += escapeRe(gap);
            literal += gap;
        }
        const text = tokenText(source, t);
        if (isMinifiedIdent(source, tokens, k)) {
            pattern += II;
            iiCount++;
        } else {
            pattern += escapeRe(text);
            literal += text;
            if (t.kind === "str" || t.kind === "template") {
                contentWeight += text.length;
                if (text !== "\"use strict\"" && text !== "'use strict'") hasAnchor = true;
            } else if (t.kind === "regex") {
                contentWeight += text.length;
            } else if (t.kind === "ident") {
                contentWeight += text.length;
                if (text.length >= MIN_STABLE_IDENT_LEN) hasAnchor = true;
            }
        }
        cursor = t.end;
    }

    return { pattern, literal, iiCount, contentWeight, hasAnchor };
}

export function generateTokenFinds(source: string, opts: TokenFindsOptions = {}): TokenFind[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const requireParam = opts.requireParam ?? detectRequireParam(source);

    const tokens = tokenize(source);
    const spans = computeVolatileSpans(source, requireParam);

    const seen = new Set<string>();
    const out: TokenFind[] = [];

    for (const [lo, hi] of collectRuns(tokens, spans)) {
        const { pattern, literal, iiCount, contentWeight, hasAnchor } = buildRun(source, tokens, lo, hi);
        if (!hasAnchor) continue;
        if (pattern.length === 0 || pattern.length > MAX_FIND_LEN) continue;
        if (seen.has(pattern)) continue;

        let re: RegExp;
        try {
            re = new RegExp(expandIi(pattern));
        } catch {
            continue;
        }
        if (!re.test(source)) continue;

        seen.add(pattern);

        const dur = scoreDurability(literal);
        const bonus = Math.min(MAX_RESILIENCE_BONUS, iiCount);
        const durability = Math.min(DURABILITY_MAX, dur.score + bonus);
        const reasons = [...dur.reasons];
        if (bonus > 0) reasons.push(`abstracts ${iiCount} minified identifier(s) to the \\i metaclass so it survives minified renaming across builds`);

        out.push({ find: pattern, score: contentWeight, durability, tier: dur.tier, reasons });
    }

    out.sort((a, b) => (b.durability - a.durability) || (b.score - a.score) || (a.find.length - b.find.length));
    return out.slice(0, limit);
}
