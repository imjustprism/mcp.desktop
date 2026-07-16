/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type DurabilityTier, scoreDurability } from "./durability";
import { type Token, tokenize } from "./tokenizer";

export type Span = readonly [start: number, end: number];

export interface GenFind {
    readonly find: string;
    readonly score: number;
    readonly durability: number;
    readonly tier: DurabilityTier;
    readonly type: "sequence" | "intl" | "pair";
    readonly regex?: boolean;
    readonly unique?: boolean;
    readonly reasons: readonly string[];
}

export interface GenFindsOptions {
    hashToKey?: (hash: string) => string | null | undefined;
    isUnique?: (find: string) => boolean;
    minScore?: number;
    limit?: number;
    requireParam?: string;
    synthesizePairs?: boolean;
    maxPairGap?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_FIND_LEN = 400;
const MIN_CONTENT_SCORE = 6;
const MIN_STABLE_IDENT_LEN = 4;
const DEFAULT_MAX_PAIR_GAP = 60;
const PAIR_GAP_SLACK = 10;
const MAX_PAIR_FINDS = 24;
const MAX_PAIR_ATTEMPTS = 4000;

const MODULE_HEADER_RE = /^0,(?:function)?\(\w+,\w+,(\w+)\)/;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectRequireParam(source: string): string | undefined {
    return MODULE_HEADER_RE.exec(source.slice(0, 40))?.[1];
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
    if (intervals.length <= 1) return intervals;
    intervals.sort((a, b) => a[0] - b[0]);
    const out: Array<[number, number]> = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const last = out[out.length - 1];
        const cur = intervals[i];
        if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
        else out.push(cur);
    }
    return out;
}

export function computeVolatileSpans(source: string, requireParam: string | undefined): readonly Span[] {
    const patterns: RegExp[] = [
        /webpackId:\s*"?\d+"?/g
    ];
    if (requireParam) {
        const p = escapeRe(requireParam);
        patterns.push(
            new RegExp("(?<![\\w$.])" + p + "(?:\\.n)?\\(\\d+\\)", "g"),
            new RegExp(p + "\\.n\\([$\\w]+\\)", "g"),
            new RegExp(p + "\\.t\\(\\d+(?:,\\s*\\d+)?\\)", "g"),
            new RegExp(p + "\\.t\\.bind\\(" + p + ",\\d+(?:,\\s*\\d+)?\\)", "g"),
            new RegExp(p + "\\.e\\((?:\"[^\"]*\"|'[^']*'|\\d+)\\)", "g"),
            new RegExp(p + "\\.bind\\(" + p + ",\\d+\\)", "g"),
            new RegExp("\\bvar\\s+(?:[$\\w]+=(?:" + p + "\\(\\d+\\)|" + p + "\\.n\\([$\\w]+\\)),?)+;", "g")
        );
    }
    const spans: Array<[number, number]> = [];
    for (const re of patterns) {
        for (const m of source.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
    }
    return mergeIntervals(spans);
}

function makeVolatileSpanTest(spans: readonly Span[]): (start: number, end: number) => boolean {
    return (start, end) => {
        let lo = 0;
        let hi = spans.length - 1;
        let ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (spans[mid][0] < end) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans >= 0 && spans[ans][1] > start;
    };
}

function isContentToken(t: Token): boolean {
    return t.kind === "ident" || t.kind === "str" || t.kind === "template" || t.kind === "regex";
}

function isStableToken(
    source: string,
    tokens: readonly Token[],
    i: number,
    inVolatileSpan: (start: number, end: number) => boolean
): boolean {
    const t = tokens[i];
    if (inVolatileSpan(t.start, t.end)) return false;
    if (t.kind !== "ident") return true;
    if (t.end - t.start >= MIN_STABLE_IDENT_LEN) return true;
    const prev = tokens[i - 1];
    return prev?.kind === "punct" && source[prev.start] === ".";
}

function segmentStableRuns(
    source: string,
    tokens: readonly Token[],
    inVolatileSpan: (start: number, end: number) => boolean
): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    let open = -1;
    for (let i = 0; i <= tokens.length; i++) {
        if (i < tokens.length && isStableToken(source, tokens, i, inVolatileSpan)) {
            if (open < 0) open = i;
        } else if (open >= 0) {
            runs.push([open, i]);
            open = -1;
        }
    }
    return runs;
}

function contentWeight(tokens: readonly Token[], lo: number, hi: number): number {
    let weight = 0;
    for (let k = lo; k < hi; k++) {
        const t = tokens[k];
        if (isContentToken(t)) weight += t.end - t.start;
    }
    return weight;
}

const INTL_DOT_RE = /\.t\.([A-Za-z0-9+/]{6})(?![A-Za-z0-9+/])/g;
const INTL_BRACKET_RE = /\.t\["([A-Za-z0-9+/]{6})"\]/g;

function collectIntlFinds(source: string, hashToKey: GenFindsOptions["hashToKey"]): GenFind[] {
    if (!hashToKey) return [];
    const byKey = new Map<string, GenFind>();
    for (const re of [INTL_DOT_RE, INTL_BRACKET_RE]) {
        for (const m of source.matchAll(re)) {
            const key = hashToKey(m[1]);
            if (!key || byKey.has(key)) continue;
            const find = `#{intl::${key}}`;
            const dur = scoreDurability(find);
            byKey.set(key, { find, score: dur.score, durability: dur.score, tier: dur.tier, type: "intl", reasons: dur.reasons });
        }
    }
    return [...byKey.values()];
}

export function generateFinds(source: string, opts: GenFindsOptions = {}): GenFind[] {
    const minScore = opts.minScore ?? MIN_CONTENT_SCORE;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const requireParam = opts.requireParam ?? detectRequireParam(source);

    const tokens = tokenize(source);
    const inVolatileSpan = makeVolatileSpanTest(computeVolatileSpans(source, requireParam));

    const seen = new Set<string>();
    const candidates: GenFind[] = [];
    const runSpans: Array<{ find: string; start: number; end: number; durability: number; tier: DurabilityTier; score: number }> = [];

    for (const f of collectIntlFinds(source, opts.hashToKey)) {
        if (seen.has(f.find)) continue;
        seen.add(f.find);
        candidates.push(f);
    }

    for (const [lo, hi] of segmentStableRuns(source, tokens, inVolatileSpan)) {
        const score = contentWeight(tokens, lo, hi);
        if (score < minScore) continue;
        const { start } = tokens[lo];
        const { end } = tokens[hi - 1];
        const find = source.slice(start, end);
        if (find.length > MAX_FIND_LEN || seen.has(find)) continue;
        seen.add(find);
        const dur = scoreDurability(find);
        candidates.push({ find, score, durability: dur.score, tier: dur.tier, type: "sequence", reasons: dur.reasons });
        runSpans.push({ find, start, end, durability: dur.score, tier: dur.tier, score });
    }

    if (opts.synthesizePairs && runSpans.length >= 2) {
        const maxGap = opts.maxPairGap ?? DEFAULT_MAX_PAIR_GAP;
        runSpans.sort((a, b) => a.start - b.start);
        let added = 0;
        let attempts = 0;
        outer:
        for (let i = 0; i < runSpans.length && added < MAX_PAIR_FINDS; i++) {
            const left = runSpans[i];
            for (let j = i + 1; j < runSpans.length; j++) {
                const right = runSpans[j];
                const gap = right.start - left.end;
                if (gap < 0) continue;
                if (gap > maxGap) break;
                if (++attempts > MAX_PAIR_ATTEMPTS) break outer;
                const pattern = escapeRe(left.find) + `[\\s\\S]{0,${gap + PAIR_GAP_SLACK}}` + escapeRe(right.find);
                if (pattern.length > MAX_FIND_LEN || seen.has(pattern)) continue;
                try { new RegExp(pattern); } catch { continue; }
                seen.add(pattern);
                candidates.push({
                    find: pattern,
                    score: left.score + right.score,
                    durability: Math.max(0, Math.min(left.durability, right.durability) - 1),
                    tier: left.durability <= right.durability ? left.tier : right.tier,
                    type: "pair",
                    regex: true,
                    reasons: ["two stable fragments joined by a bounded gap, for modules with no unique single anchor"]
                });
                if (++added >= MAX_PAIR_FINDS) break;
            }
        }
    }

    const { isUnique } = opts;
    let result = candidates;
    if (isUnique) {
        result = candidates.map(c => ({ ...c, unique: isUnique(c.find) })).filter(c => c.unique);
    }

    result.sort((a, b) => (b.durability - a.durability) || (b.score - a.score) || (a.find.length - b.find.length));
    return result.slice(0, limit);
}
