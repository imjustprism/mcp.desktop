/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

import { IntlToolArgs, PatternData } from "../types";
import { createIntlHashBracketRegex, createIntlHashDotRegex } from "./constants";
import {
    buildIntlHashToKeyMap,
    extractIntlText,
    getIntlKeyFromHash,
    getIntlMessageFromHash,
    getLocaleMessages,
    getModuleSource,
    KEY_MAP,
    runtimeHashMessageKey,
    searchModulesOptimized,
} from "./utils";

let patternCache: PatternData | null = null;

function increment(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function sortByFrequency(counts: Map<string, number>, min = 2): string[] {
    return [...counts.entries()]
        .filter(([, count]) => count >= min)
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => key);
}

function buildPatternData(): PatternData {
    if (patternCache) return patternCache;

    const starters = new Map<string, number>();
    const transitionCounts = new Map<string, Map<string, number>>();
    const parts = new Map<string, number>();
    const prefixes = new Map<string, number>();
    const prefixes2 = new Map<string, number>();
    const suffixes = new Map<string, number>();
    const suffixes2 = new Map<string, number>();

    for (const key of Object.values(KEY_MAP)) {
        const segs = key.split("_");
        if (!segs.length) continue;

        increment(starters, segs[0]);
        for (const seg of segs) if (seg.length >= 2) increment(parts, seg);

        for (let i = 0; i < segs.length - 1; i++) {
            if (!transitionCounts.has(segs[i])) transitionCounts.set(segs[i], new Map());
            increment(transitionCounts.get(segs[i])!, segs[i + 1]);
        }

        if (segs.length >= 2) {
            increment(prefixes, segs[0]);
            increment(suffixes, segs[segs.length - 1]);
        }
        if (segs.length >= 3) {
            increment(prefixes2, segs.slice(0, 2).join("_"));
            increment(suffixes2, segs.slice(-2).join("_"));
        }
    }

    const transitions = new Map<string, string[]>();
    for (const [from, toMap] of transitionCounts) transitions.set(from, sortByFrequency(toMap, 1));

    patternCache = {
        starters: sortByFrequency(starters, 1),
        transitions,
        parts: sortByFrequency(parts, 1),
        prefixes: sortByFrequency(prefixes, 2),
        prefixes2: sortByFrequency(prefixes2, 2),
        suffixes: sortByFrequency(suffixes, 2),
        suffixes2: sortByFrequency(suffixes2, 2),
    };

    return patternCache;
}

function extractWords(message: string): string[] {
    return message
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 2)
        .slice(0, 6);
}

function* yieldTransitionChain(start: string, transitions: Map<string, string[]>, maxDepth: number, limits: number[]): Generator<string> {
    const queue: string[][] = [[start]];
    while (queue.length) {
        const path = queue.shift()!;
        if (path.length > 1) yield path.join("_");
        if (path.length > maxDepth) continue;
        const next = transitions.get(path[path.length - 1]);
        if (!next) continue;
        for (const n of next.slice(0, limits[path.length - 1] ?? 10)) {
            queue.push([...path, n]);
        }
    }
}

function* yieldCombinations(lists: string[][]): Generator<string> {
    if (!lists.length) return;
    if (lists.length === 1) { for (const a of lists[0]) yield a; return; }
    if (lists.length === 2) { for (const a of lists[0]) for (const b of lists[1]) yield `${a}_${b}`; return; }
    for (const a of lists[0]) for (const b of lists[1]) for (const c of lists[2]) yield `${a}_${b}_${c}`;
}

function* generateCandidates(words: string[], patterns: PatternData): Generator<string> {
    if (!words.length) return;

    for (const word of words) yield word;

    for (let i = 0; i < words.length; i++)
        for (let j = i + 1; j <= Math.min(words.length, i + 4); j++)
            yield words.slice(i, j).join("_");

    for (const starter of patterns.starters) {
        yield starter;
        for (const word of words) {
            yield `${starter}_${word}`;
            for (const chain of yieldTransitionChain(starter, patterns.transitions, 3, [30, 20, 10])) {
                yield chain;
                for (const w of words) { yield `${chain}_${w}`; yield `${w}_${chain}`; }
            }
        }
    }

    for (const word of words) {
        yield* yieldTransitionChain(word, patterns.transitions, 4, [60, 30, 15, 10]);

        for (const starter of patterns.starters) {
            if (!patterns.transitions.get(starter)?.includes(word)) continue;
            yield `${starter}_${word}`;
            for (const chain of yieldTransitionChain(word, patterns.transitions, 2, [40, 20])) {
                yield `${starter}_${chain}`;
            }
        }
    }

    const cores = words.flatMap((_, i) =>
        Array.from({ length: Math.min(words.length, i + 3) - i }, (__, j) => words.slice(i, i + j + 1).join("_"))
    );

    const prefixSuffixPairs: Array<[string[], string[], number]> = [
        [patterns.prefixes.slice(0, 400), words, 0],
        [patterns.prefixes2.slice(0, 300), words, 0],
        [words, patterns.suffixes.slice(0, 300), 0],
        [words, patterns.suffixes2.slice(0, 250), 0],
        [patterns.prefixes.slice(0, 300), cores, 0],
        [patterns.prefixes2.slice(0, 250), cores, 0],
        [cores, patterns.suffixes.slice(0, 250), 0],
        [cores, patterns.suffixes2.slice(0, 150), 0],
    ];

    for (const [a, b] of prefixSuffixPairs) yield* yieldCombinations([a, b]);

    const tripleSpecs: Array<[string[], string[], string[]]> = [
        [patterns.prefixes.slice(0, 200), words, patterns.suffixes.slice(0, 150)],
        [patterns.prefixes2.slice(0, 150), words, patterns.suffixes.slice(0, 120)],
        [patterns.prefixes.slice(0, 150), words, patterns.suffixes2.slice(0, 120)],
        [patterns.prefixes.slice(0, 120), cores, patterns.suffixes.slice(0, 100)],
    ];

    for (const [a, b, c] of tripleSpecs) yield* yieldCombinations([a, b, c]);

    for (const part of patterns.parts.slice(0, 120)) {
        for (const word of words) {
            if (part === word) continue;
            yield `${part}_${word}`;
            yield `${word}_${part}`;
        }
    }
}

function getMessage(hash: string): string | null {
    const locale = getLocaleMessages();
    if (locale?.[hash]) return extractIntlText(locale[hash]);
    return getIntlMessageFromHash(hash);
}

export async function handleIntlTool(args: IntlToolArgs): Promise<unknown> {
    const { action, key, hash, hashes, query, moduleId, candidates, prefixes, suffixes, mids, pattern, parts } = args;
    const limit = args.limit ?? 20;

    if (action === "hash" || (key && !action)) {
        if (!key) return { error: true, message: "key required" };
        const h = runtimeHashMessageKey(key);
        const msg = getMessage(h);
        const exists = !!msg;
        return { key, hash: h, find: `#{intl::${key}}`, message: msg, exists, warning: exists ? undefined : "Key not in Discord intl definitions, hash may be invalid" };
    }

    if (action === "reverse" || (hash && !action && !key)) {
        if (!hash) return { error: true, message: "hash required" };
        const k = getIntlKeyFromHash(hash);
        return { hash, key: k, find: k ? `#{intl::${k}}` : null, message: getMessage(hash) };
    }

    if (action === "search" || (query && !action)) {
        if (!query) return { error: true, message: "query required" };

        const searchTerms = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
        const queryLower = query.toLowerCase();
        const locale = getLocaleMessages();
        if (!locale) return { query, count: 0, matches: [] };

        const hashMap = buildIntlHashToKeyMap();
        const exact: Array<{ hash: string; message: string; key?: string }> = [];
        const partial: Array<{ hash: string; message: string; key?: string }> = [];

        for (const [h, arr] of Object.entries(locale)) {
            const text = extractIntlText(arr);
            if (!text) continue;

            const lower = text.toLowerCase();
            const isMatch = searchTerms.length > 1
                ? searchTerms.every(term => lower.includes(term))
                : lower.includes(queryLower);

            if (!isMatch) continue;

            const entry: { hash: string; message: string; key?: string; find?: string } = {
                hash: h,
                message: text.slice(0, 200)
            };
            const known = hashMap.get(h);
            if (known) {
                entry.key = known;
                entry.find = `#{intl::${known}}`;
            }

            if (lower === queryLower) exact.push(entry);
            else partial.push(entry);
        }

        const matches = [...exact, ...partial].slice(0, limit);
        return { query, count: matches.length, matches };
    }

    if (action === "scan" && moduleId) {
        const source = getModuleSource(moduleId);
        if (!source) return { error: true, message: `module ${moduleId} not found` };

        const hashPatterns = [
            createIntlHashDotRegex(),
            createIntlHashBracketRegex(),
            /intl\.string\(\w+\.t\.([A-Za-z0-9+/]{6})\)/g,
            /"([A-Za-z0-9+/]{6})":\s*\[/g
        ];

        const found = new Set<string>();
        for (const regex of hashPatterns) {
            let match;
            while ((match = regex.exec(source))) {
                if (match[1].length === 6) found.add(match[1]);
            }
        }

        const results = [...found].map(h => {
            const k = getIntlKeyFromHash(h);
            return { hash: h, key: k, find: k ? `#{intl::${k}}` : `#{intl::${h}::raw}`, message: getMessage(h) };
        });
        return { moduleId, count: found.size, hashes: results };
    }

    if (action === "targets") {
        if (!key) return { error: true, message: "key required" };
        const h = runtimeHashMessageKey(key);
        const dotUsage = `.t.${h}`;
        const bracketUsage = `.t["${h}"]`;
        return {
            key,
            hash: h,
            message: getMessage(h),
            modules: searchModulesOptimized(src => src.includes(dotUsage) || src.includes(bracketUsage), limit)
        };
    }

    if (action === "bruteforce") {
        if (!hash) return { error: true, message: "hash required" };

        const msg = getMessage(hash);
        let tested = 0;

        for (const k of Object.values(KEY_MAP)) {
            tested++;
            if (runtimeHashMessageKey(k) === hash) {
                return { hash, message: msg?.slice(0, 100), found: k, find: `#{intl::${k}}`, tested, source: "keymap" };
            }
        }

        const pluginKey = buildIntlHashToKeyMap().get(hash);
        if (pluginKey) {
            return { hash, message: msg?.slice(0, 100), found: pluginKey, find: `#{intl::${pluginKey}}`, tested, source: "plugins" };
        }

        if (msg) {
            const words = extractWords(msg);
            const patterns = buildPatternData();
            const seen = new Set<string>();
            let ops = 0;

            for (const candidate of generateCandidates(words, patterns)) {
                if (candidate.length < 2 || candidate.length > 80 || seen.has(candidate)) continue;

                seen.add(candidate);
                tested++;
                ops++;

                if (ops >= 1000) {
                    ops = 0;
                    await sleep(0);
                }

                if (runtimeHashMessageKey(candidate) === hash) {
                    return { hash, message: msg.slice(0, 100), found: candidate, find: `#{intl::${candidate}}`, tested, source: "generated" };
                }
            }
        }

        return { hash, message: msg?.slice(0, 100), found: null, raw: `#{intl::${hash}::raw}`, tested, hint: "use test action with custom candidates" };
    }

    if (action === "test") {
        const targets = hashes ?? (hash ? [hash] : []);
        if (!targets.length) return { error: true, message: "hash or hashes required" };

        const targetSet = new Set(targets);
        const results = new Map<string, { message: string | null; matches: string[] }>();

        for (const h of targets) {
            results.set(h, { message: getMessage(h)?.slice(0, 100) ?? null, matches: [] });
        }

        let tested = 0;

        const tryKey = (candidate: string) => {
            tested++;
            const h = runtimeHashMessageKey(candidate);
            if (targetSet.has(h)) {
                results.get(h)!.matches.push(candidate);
            }
        };

        if (candidates?.length) {
            for (const c of candidates) tryKey(c);
        }

        if (prefixes?.length || suffixes?.length || mids?.length) {
            const preList = prefixes?.length ? prefixes : [""];
            const midList = mids?.length ? mids : [""];
            const sufList = suffixes?.length ? suffixes : [""];

            for (const pre of preList) {
                for (const mid of midList) {
                    for (const suf of sufList) {
                        const segments = [pre, mid, suf].filter(s => s.length > 0);
                        if (segments.length) tryKey(segments.join("_"));
                    }
                }
            }
        }

        if (pattern && parts) {
            const placeholders = pattern.match(/\{(\w+)\}/g)?.map(p => p.slice(1, -1)) ?? [];

            const expand = (idx: number, current: string) => {
                if (idx >= placeholders.length) {
                    tryKey(current);
                    return;
                }
                const name = placeholders[idx];
                for (const val of parts[name] ?? [""]) {
                    expand(idx + 1, current.replace(`{${name}}`, val));
                }
            };

            if (placeholders.length) expand(0, pattern);
        }

        const found: Array<{ hash: string; key: string; message: string | null }> = [];
        const notFound: string[] = [];

        for (const [h, result] of results) {
            if (result.matches.length) {
                for (const key of result.matches) {
                    found.push({ hash: h, key, message: result.message });
                }
            } else {
                notFound.push(h);
            }
        }

        return { tested, found, notFound };
    }

    return { error: true, message: "action: hash, reverse, search, scan, targets, bruteforce, test" };
}
