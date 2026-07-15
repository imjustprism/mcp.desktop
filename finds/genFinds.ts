import { type DurabilityTier, scoreDurability } from "./durability";
import { type Token, tokenize, tokenText } from "./tokenizer";

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

const DEFAULT_MIN_SCORE = 8;
const DEFAULT_LIMIT = 100;
const MAX_FIND_LEN = 400;
const MAX_MINIFIED_IDENT_LEN = 4;
const DEFAULT_MAX_PAIR_GAP = 60;
const PAIR_GAP_SLACK = 10;
const MAX_PAIR_FINDS = 24;
const MAX_PAIR_ATTEMPTS = 4000;

const MODULE_HEADER_RE = /^0,(?:function)?\(\w+,\w+,(\w+)\)/;

const FULL_WEIGHT_KEYWORDS: ReadonlySet<string> = new Set([
    "null", "void", "typeof", "for", "new", "instanceof", "delete"
]);
const STRUCTURAL_PUNCT: ReadonlySet<string> = new Set([
    "(", ")", "[", "]", "{", "}", ",", ".", ";", "=>"
]);

function ilog2(x: number): number {
    return x < 1 ? 0 : Math.floor(Math.log2(x));
}

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

export function computeBadSpans(source: string, requireParam: string | undefined): readonly Span[] {
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

function makeOverlapsBadSpan(spans: readonly Span[]): (start: number, end: number) => boolean {
    return (start: number, end: number) => {
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

function survivesMinification(t: Token): boolean {
    if (t.kind === "ident") return t.end - t.start > MAX_MINIFIED_IDENT_LEN;
    return true;
}

function isContentToken(t: Token): boolean {
    return t.kind === "ident" || t.kind === "str" || t.kind === "template" || t.kind === "regex";
}

function scoreRun(source: string, run: Token[]): number {
    let score = run[run.length - 1].end - run[0].start;
    for (const t of run) {
        const tl = t.end - t.start;
        switch (t.kind) {
            case "ident":
            case "str":
            case "template":
            case "regex":
                score += tl * ilog2(tl);
                break;
            case "number":
                score += Math.min(tl * ilog2(tl), 1);
                break;
            case "keyword": {
                const kw = tokenText(source, t);
                if (kw === "return" || kw === "function") score += Math.floor(kw.length / 2);
                else if (FULL_WEIGHT_KEYWORDS.has(kw)) score += kw.length;
                else score += 1;
                break;
            }
            case "punct":
                score += STRUCTURAL_PUNCT.has(tokenText(source, t)) ? 0 : 1;
                break;
            default:
                t.kind satisfies never;
        }
    }
    return score;
}

function isRejectedLoneRun(source: string, run: Token[]): boolean {
    if (run.length !== 1) return false;
    const t = run[0];
    if (t.kind === "punct") return true;
    if (t.kind === "keyword") {
        const kw = tokenText(source, t);
        return kw === "extends" || kw === "let" || kw === "var" || kw === "const";
    }
    return false;
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
    const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const requireParam = opts.requireParam ?? detectRequireParam(source);

    const tokens = tokenize(source);
    const overlapsBadSpan = makeOverlapsBadSpan(computeBadSpans(source, requireParam));

    const seen = new Set<string>();
    const candidates: GenFind[] = [];
    const runSpans: Array<{ find: string; start: number; end: number; durability: number; tier: DurabilityTier; score: number }> = [];

    for (const f of collectIntlFinds(source, opts.hashToKey)) {
        if (seen.has(f.find)) continue;
        seen.add(f.find);
        candidates.push(f);
    }

    let run: Token[] = [];
    const flush = () => {
        const cs = run;
        run = [];
        if (cs.length === 0) return;
        if (isRejectedLoneRun(source, cs)) return;
        if (!cs.some(isContentToken)) return;
        const score = scoreRun(source, cs);
        if (score < minScore) return;
        const find = source.slice(cs[0].start, cs[cs.length - 1].end);
        if (find.length > MAX_FIND_LEN) return;
        if (seen.has(find)) return;
        seen.add(find);
        const dur = scoreDurability(find);
        candidates.push({ find, score, durability: dur.score, tier: dur.tier, type: "sequence", reasons: dur.reasons });
        runSpans.push({ find, start: cs[0].start, end: cs[cs.length - 1].end, durability: dur.score, tier: dur.tier, score });
    };

    for (const t of tokens) {
        if (survivesMinification(t) && !overlapsBadSpan(t.start, t.end)) run.push(t);
        else flush();
    }
    flush();

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
                    reasons: ["two stable fragments joined by a bounded gap — for modules with no unique single anchor"]
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
