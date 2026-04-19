/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IntlToolArgs, PatternData } from "../types";
import { createIntlHashBracketRegex, createIntlHashDotRegex } from "./constants";
import * as u from "./utils";

let patternCache: PatternData | null = null;
let patternCacheKeyMapSize = 0;

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
    const currentSize = Object.keys(u.KEY_MAP).length;
    if (patternCache && patternCacheKeyMapSize === currentSize) return patternCache;
    patternCache = null;

    const starters = new Map<string, number>();
    const transitionCounts = new Map<string, Map<string, number>>();
    const parts = new Map<string, number>();
    const prefixes = new Map<string, number>();
    const prefixes2 = new Map<string, number>();
    const prefixes3 = new Map<string, number>();
    const suffixes = new Map<string, number>();
    const suffixes2 = new Map<string, number>();
    const suffixes3 = new Map<string, number>();

    for (const key of Object.values(u.KEY_MAP)) {
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
        if (segs.length >= 4) {
            increment(prefixes3, segs.slice(0, 3).join("_"));
            increment(suffixes3, segs.slice(-3).join("_"));
        }
    }

    const transitions = new Map<string, string[]>();
    for (const [from, toMap] of transitionCounts) transitions.set(from, sortByFrequency(toMap, 1));

    patternCacheKeyMapSize = currentSize;
    patternCache = {
        starters: sortByFrequency(starters, 1),
        transitions,
        parts: sortByFrequency(parts, 1),
        prefixes: sortByFrequency(prefixes, 2),
        prefixes2: sortByFrequency(prefixes2, 2),
        prefixes3: sortByFrequency(prefixes3, 2),
        suffixes: sortByFrequency(suffixes, 2),
        suffixes2: sortByFrequency(suffixes2, 2),
        suffixes3: sortByFrequency(suffixes3, 2),
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
    let head = 0;
    while (head < queue.length) {
        const path = queue[head++];
        if (path.length > 1) yield path.join("_");
        if (path.length > maxDepth) continue;
        const next = transitions.get(path[path.length - 1]);
        if (!next) continue;
        const cap = limits[path.length - 1] ?? 10;
        const end = Math.min(next.length, cap);
        for (let i = 0; i < end; i++) queue.push([...path, next[i]]);
    }
}

function* yieldCombinations(lists: string[][]): Generator<string> {
    if (!lists.length) return;
    if (lists.length === 1) {
        for (const a of lists[0]) yield a;
        return;
    }
    if (lists.length === 2) {
        for (const a of lists[0]) for (const b of lists[1]) yield `${a}_${b}`;
        return;
    }
    for (const a of lists[0]) for (const b of lists[1]) for (const c of lists[2]) yield `${a}_${b}_${c}`;
}

function findNeighborKeys(hash: string): string[] {
    const locale = u.getLocaleMessages();
    if (!locale) return [];
    const allHashes = Object.keys(locale);
    const idx = allHashes.indexOf(hash);
    if (idx === -1) return [];

    const nearby = allHashes.slice(Math.max(0, idx - 8), idx + 9).filter(h => h !== hash);
    const hashMap = u.buildIntlHashToKeyMap();
    return nearby.map(h => hashMap.get(h)).filter(u.isNonNullish);
}

function extractPrefixesFromKeys(keys: string[]): string[] {
    const prefixCounts = new Map<string, number>();
    for (const key of keys) {
        const segs = key.split("_");
        for (let len = 1; len <= Math.min(segs.length - 1, 4); len++) {
            const prefix = segs.slice(0, len).join("_");
            increment(prefixCounts, prefix);
        }
    }
    return [...prefixCounts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([k]) => k);
}

function* generateCandidates(words: string[], patterns: PatternData, neighborKeys?: string[]): Generator<string> {
    if (!words.length) return;

    for (const word of words) yield word;

    for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) yield words.slice(i, j).join("_");

    const cores = words.flatMap((_, i) => Array.from({ length: Math.min(words.length, i + 3) - i }, (__, j) => words.slice(i, i + j + 1).join("_")));

    if (neighborKeys?.length) {
        const contextPrefixes = extractPrefixesFromKeys(neighborKeys);

        const contextSuffixes = new Set<string>();
        for (const key of neighborKeys) {
            const segs = key.split("_");
            for (let len = 1; len <= Math.min(segs.length - 1, 4); len++) {
                contextSuffixes.add(segs.slice(-len).join("_"));
            }
        }
        const ctxSuffixes = [...contextSuffixes];

        for (const prefix of contextPrefixes) {
            for (const word of words) {
                yield `${prefix}_${word}`;
                for (const w2 of words) {
                    if (w2 === word) continue;
                    yield `${prefix}_${word}_${w2}`;
                    yield `${prefix}_${w2}_${word}`;
                }
            }
            for (const core of cores) {
                yield `${prefix}_${core}`;
            }
            for (const suf of ctxSuffixes) {
                yield `${prefix}_${suf}`;
                for (const word of words) {
                    yield `${prefix}_${word}_${suf}`;
                    for (const w2 of words) {
                        if (w2 === word) continue;
                        yield `${prefix}_${word}_${w2}_${suf}`;
                    }
                }
                for (const core of cores) {
                    yield `${prefix}_${core}_${suf}`;
                }
            }

            for (const part of patterns.parts.slice(0, 200)) {
                yield `${prefix}_${part}`;
                for (const suf of ctxSuffixes) {
                    yield `${prefix}_${part}_${suf}`;
                }
                for (const word of words) {
                    yield `${prefix}_${part}_${word}`;
                    yield `${prefix}_${word}_${part}`;
                    for (const suf of ctxSuffixes) {
                        yield `${prefix}_${word}_${part}_${suf}`;
                        yield `${prefix}_${part}_${word}_${suf}`;
                    }
                }
            }
        }
    }

    for (const starter of patterns.starters) {
        yield starter;
        for (const word of words) {
            yield `${starter}_${word}`;
            for (const chain of yieldTransitionChain(starter, patterns.transitions, 5, [30, 25, 20, 15, 10])) {
                yield chain;
                for (const w of words) {
                    yield `${chain}_${w}`;
                    yield `${w}_${chain}`;
                }
            }
        }
    }

    for (const word of words) {
        yield* yieldTransitionChain(word, patterns.transitions, 6, [60, 40, 25, 15, 10, 8]);

        for (const starter of patterns.starters) {
            if (!patterns.transitions.get(starter)?.includes(word)) continue;
            yield `${starter}_${word}`;
            for (const chain of yieldTransitionChain(word, patterns.transitions, 4, [40, 25, 15, 10])) {
                yield `${starter}_${chain}`;
            }
        }
    }

    const prefixSuffixPairs: Array<[string[], string[]]> = [
        [patterns.prefixes.slice(0, 400), words],
        [patterns.prefixes2.slice(0, 300), words],
        [patterns.prefixes3.slice(0, 200), words],
        [words, patterns.suffixes.slice(0, 300)],
        [words, patterns.suffixes2.slice(0, 250)],
        [words, patterns.suffixes3.slice(0, 200)],
        [patterns.prefixes.slice(0, 300), cores],
        [patterns.prefixes2.slice(0, 250), cores],
        [patterns.prefixes3.slice(0, 200), cores],
        [cores, patterns.suffixes.slice(0, 250)],
        [cores, patterns.suffixes2.slice(0, 150)],
        [cores, patterns.suffixes3.slice(0, 120)],
    ];

    for (const [a, b] of prefixSuffixPairs) yield* yieldCombinations([a, b]);

    const tripleSpecs: Array<[string[], string[], string[]]> = [
        [patterns.prefixes.slice(0, 200), words, patterns.suffixes.slice(0, 150)],
        [patterns.prefixes2.slice(0, 150), words, patterns.suffixes.slice(0, 120)],
        [patterns.prefixes2.slice(0, 150), words, patterns.suffixes2.slice(0, 100)],
        [patterns.prefixes3.slice(0, 120), words, patterns.suffixes.slice(0, 100)],
        [patterns.prefixes3.slice(0, 100), words, patterns.suffixes2.slice(0, 80)],
        [patterns.prefixes3.slice(0, 80), words, patterns.suffixes3.slice(0, 60)],
        [patterns.prefixes.slice(0, 150), words, patterns.suffixes2.slice(0, 120)],
        [patterns.prefixes.slice(0, 120), words, patterns.suffixes3.slice(0, 100)],
        [patterns.prefixes.slice(0, 120), cores, patterns.suffixes.slice(0, 100)],
        [patterns.prefixes2.slice(0, 100), cores, patterns.suffixes2.slice(0, 80)],
        [patterns.prefixes3.slice(0, 80), cores, patterns.suffixes3.slice(0, 60)],
    ];

    for (const [a, b, c] of tripleSpecs) yield* yieldCombinations([a, b, c]);

    for (const part of patterns.parts.slice(0, 200)) {
        for (const word of words) {
            if (part === word) continue;
            yield `${part}_${word}`;
            yield `${word}_${part}`;
        }
    }
}

function* generateCandidatesFast(words: string[], patterns: PatternData, neighborKeys?: string[]): Generator<string> {
    if (!words.length) return;

    for (const word of words) yield word;

    for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) yield words.slice(i, j).join("_");

    const cores = words.flatMap((_, i) => Array.from({ length: Math.min(words.length, i + 3) - i }, (__, j) => words.slice(i, i + j + 1).join("_")));

    if (neighborKeys?.length) {
        const contextPrefixes = extractPrefixesFromKeys(neighborKeys).slice(0, 30);
        const contextSuffixes = new Set<string>();
        for (const key of neighborKeys) {
            const segs = key.split("_");
            for (let len = 1; len <= Math.min(segs.length - 1, 3); len++) contextSuffixes.add(segs.slice(-len).join("_"));
        }

        for (const prefix of contextPrefixes) {
            for (const word of words) {
                yield `${prefix}_${word}`;
                for (const w2 of words) {
                    if (w2 !== word) yield `${prefix}_${word}_${w2}`;
                }
            }
            for (const core of cores) yield `${prefix}_${core}`;
            for (const suf of contextSuffixes) {
                yield `${prefix}_${suf}`;
                for (const word of words) yield `${prefix}_${word}_${suf}`;
                for (const core of cores) yield `${prefix}_${core}_${suf}`;
            }
        }
    }

    for (const [a, b] of [
        [patterns.prefixes.slice(0, 60), words],
        [patterns.prefixes2.slice(0, 40), words],
        [words, patterns.suffixes.slice(0, 60)],
        [words, patterns.suffixes2.slice(0, 40)],
    ] as Array<[string[], string[]]>)
        yield* yieldCombinations([a, b]);

    for (const part of patterns.parts.slice(0, 50)) {
        for (const word of words) {
            if (part !== word) {
                yield `${part}_${word}`;
                yield `${word}_${part}`;
            }
        }
    }
}

function getMessage(hash: string): string | null {
    const locale = u.getLocaleMessages();
    if (locale?.[hash]) return u.extractIntlText(locale[hash]);
    return u.getIntlMessageFromHash(hash);
}

export async function handleIntlTool(args: IntlToolArgs): Promise<unknown> {
    const { action, key, hash, hashes, query, moduleId, candidates, prefixes, suffixes, mids, pattern, parts } = args;
    const limit = args.limit ?? 20;

    if (action === "hash" || (key && !action)) {
        if (!key) return u.missingArg("key");
        const h = u.runtimeHashMessageKey(key);
        const msg = getMessage(h);
        const exists = !!msg;
        return { key, hash: h, find: `#{intl::${key}}`, message: msg, exists, warning: exists ? undefined : "Key not in Discord intl definitions, hash may be invalid" };
    }

    if (action === "reverse" || (hash && !action && !key)) {
        if (!hash) return u.missingArg("hash");
        if (!/^[A-Za-z0-9+/]{6}$/.test(hash)) {
            return { error: true, message: `Invalid hash format: expected 6 base64 chars, got "${hash}" (${hash.length} chars)` };
        }
        const k = u.getIntlKeyFromHash(hash);
        const msg = getMessage(hash);
        const exists = !!msg && msg !== hash;
        return {
            hash,
            key: k,
            find: k ? `#{intl::${k}}` : null,
            message: exists ? msg : null,
            exists,
            warning: exists ? undefined : "Hash not found in Discord intl definitions",
        };
    }

    if (action === "search" || (query && !action)) {
        if (!query) return u.missingArg("query");

        const searchTerms = query
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length >= 2);
        const queryLower = query.toLowerCase();
        const locale = u.getLocaleMessages();
        if (!locale) return { query, count: 0, matches: [] };

        const hashMap = u.buildIntlHashToKeyMap();
        const exact: Array<{ hash: string; message: string; key?: string }> = [];
        const partial: Array<{ hash: string; message: string; key?: string }> = [];

        for (const [h, arr] of Object.entries(locale)) {
            const text = u.extractIntlText(arr);
            if (!text) continue;

            const lower = text.toLowerCase();
            const isMatch = searchTerms.length > 1 ? searchTerms.every(term => lower.includes(term)) : lower.includes(queryLower);

            if (!isMatch) continue;

            const entry: { hash: string; message: string; key?: string; find?: string } = {
                hash: h,
                message: text.slice(0, 200),
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
        const source = u.getModuleSource(moduleId);
        if (!source) return { error: true, message: `module ${moduleId} not found` };

        const hashPatterns = [createIntlHashDotRegex(), createIntlHashBracketRegex(), /intl\.string\(\w+\.t\.([A-Za-z0-9+/]{6})\)/g, /"([A-Za-z0-9+/]{6})":\s*\[/g];

        const found = new Set<string>();
        for (const regex of hashPatterns) {
            let match: RegExpExecArray | null;
            while ((match = regex.exec(source))) {
                if (match[1].length === 6) found.add(match[1]);
            }
        }

        const results = [...found].map(h => {
            const k = u.getIntlKeyFromHash(h);
            return { hash: h, key: k, find: k ? `#{intl::${k}}` : `#{intl::${h}::raw}`, message: getMessage(h) };
        });
        return { moduleId, count: found.size, hashes: results };
    }

    if (action === "targets") {
        if (!key) return u.missingArg("key");
        const h = u.runtimeHashMessageKey(key);
        const dotUsage = `.t.${h}`;
        const bracketUsage = `.t["${h}"]`;
        return {
            key,
            hash: h,
            message: getMessage(h),
            modules: u.searchModulesOptimized(src => src.includes(dotUsage) || src.includes(bracketUsage), limit),
        };
    }

    if (action === "bruteforce") {
        const SINGLE_DEADLINE_MS = 120_000;
        const BATCH_DEADLINE_MS = 30_000;
        const BURST_MS = 30;

        const yieldFrame = () => new Promise<void>(r => setTimeout(r, 0));

        if (hash) {
            const msg = getMessage(hash);
            let tested = 0;

            for (const k of Object.values(u.KEY_MAP)) {
                tested++;
                if (u.runtimeHashMessageKey(k) === hash) {
                    return { hash, message: msg?.slice(0, 100), found: k, find: `#{intl::${k}}`, tested, source: "keymap" };
                }
            }

            const pluginKey = u.buildIntlHashToKeyMap().get(hash);
            if (pluginKey) {
                return { hash, message: msg?.slice(0, 100), found: pluginKey, find: `#{intl::${pluginKey}}`, tested, source: "plugins" };
            }

            if (msg) {
                const words = extractWords(msg);
                const patterns = buildPatternData();
                const neighborKeys = findNeighborKeys(hash);
                const seen = new Set<string>();
                const deadline = Date.now() + SINGLE_DEADLINE_MS;
                let exhausted = true;
                let burstEnd = Date.now() + BURST_MS;

                const MAX_SEEN = 2_000_000;
                for (const candidate of generateCandidates(words, patterns, neighborKeys)) {
                    if (candidate.length < 2 || candidate.length > 80) continue;
                    if (seen.size < MAX_SEEN) {
                        if (seen.has(candidate)) continue;
                        seen.add(candidate);
                    }
                    tested++;

                    if (u.runtimeHashMessageKey(candidate) === hash) {
                        u.addToKeyMap({ [hash]: candidate });
                        return { hash, message: msg.slice(0, 100), found: candidate, find: `#{intl::${candidate}}`, tested, source: "generated", neighborContext: neighborKeys.slice(0, 5) };
                    }

                    if (Date.now() > burstEnd) {
                        if (Date.now() > deadline) {
                            exhausted = false;
                            break;
                        }
                        await yieldFrame();
                        burstEnd = Date.now() + BURST_MS;
                    }
                }

                return {
                    hash,
                    message: msg.slice(0, 100),
                    found: null,
                    raw: `#{intl::${hash}::raw}`,
                    tested,
                    exhausted,
                    neighborContext: neighborKeys.slice(0, 8),
                    hint: exhausted
                        ? "All generated candidates exhausted. Use test action with custom candidates based on the neighborContext keys above."
                        : `Stopped after ${Math.round(SINGLE_DEADLINE_MS / 1000)}s (${tested} candidates tested). Use test action with targeted candidates based on the neighborContext keys above.`,
                };
            }

            return {
                hash,
                message: msg?.slice(0, 100),
                found: null,
                raw: `#{intl::${hash}::raw}`,
                tested: 0,
                hint: "Hash has no message text, cannot generate candidates. Use test action with custom candidates.",
            };
        }

        const locale = u.getLocaleMessages();
        if (!locale) return { error: true, message: "Could not find intl definitions module" };

        const hashMap = u.buildIntlHashToKeyMap();
        const allHashes = Object.keys(locale).filter(k => k !== "default" && k !== "__esModule");
        const unknownHashes = new Set<string>();
        const unknownEntries: Array<{ hash: string; msg: string }> = [];

        for (const h of allHashes) {
            if (hashMap.has(h)) continue;
            const msg = u.extractIntlText(locale[h]);
            if (!msg || msg.length < 4) continue;
            unknownHashes.add(h);
            unknownEntries.push({ hash: h, msg });
        }

        const totalUnknown = unknownHashes.size;
        if (!totalUnknown) return { total: allHashes.length, found: [], foundCount: 0, unknownCount: 0, message: "All hashes are already known" };

        const found: Array<{ hash: string; key: string; message: string }> = [];
        const seen = new Set<string>(Object.values(u.KEY_MAP));
        let tested = 0;
        let exhausted = true;
        const deadline = Date.now() + BATCH_DEADLINE_MS;
        let burstEnd = Date.now() + BURST_MS;

        const unknownMap = new Map(unknownEntries.map(e => [e.hash, e.msg]));

        const MAX_SEEN = 2_000_000;
        const tryCandidate = (candidate: string) => {
            if (candidate.length < 2 || candidate.length > 80) return;
            if (seen.size < MAX_SEEN) {
                if (seen.has(candidate)) return;
                seen.add(candidate);
            }
            tested++;
            const h = u.runtimeHashMessageKey(candidate);
            if (unknownHashes.has(h)) {
                found.push({ hash: h, key: candidate, message: (unknownMap.get(h) ?? "").slice(0, 120) });
                unknownHashes.delete(h);
                unknownMap.delete(h);
            }
        };
        const patterns = buildPatternData();

        for (const { hash: h, msg } of unknownEntries) {
            if (!unknownHashes.has(h)) continue;
            const words = extractWords(msg);
            const neighborKeys = findNeighborKeys(h);

            for (const candidate of generateCandidatesFast(words, patterns, neighborKeys)) {
                tryCandidate(candidate);
                if (Date.now() > burstEnd) {
                    if (Date.now() > deadline) {
                        exhausted = false;
                        break;
                    }
                    await yieldFrame();
                    burstEnd = Date.now() + BURST_MS;
                }
            }
            if (!exhausted || !unknownHashes.size) break;
        }

        if (!found.length) return { total: allHashes.length, tested, foundCount: 0, initialUnknown: totalUnknown, remainingUnknown: unknownHashes.size, exhausted };

        const orderedHashes = u.getOrderedIntlHashes();
        if (orderedHashes) {
            const posMap = new Map(orderedHashes.map((h, i) => [h, i]));
            found.sort((a, b) => (posMap.get(a.hash) ?? Infinity) - (posMap.get(b.hash) ?? Infinity));

            const knownSet = new Set(Object.keys(u.KEY_MAP));
            for (const entry of found) {
                const pos = posMap.get(entry.hash);
                if (pos == null) continue;
                for (let i = pos - 1; i >= 0; i--) {
                    if (knownSet.has(orderedHashes[i])) {
                        (entry as Record<string, unknown>).afterHash = orderedHashes[i];
                        (entry as Record<string, unknown>).afterKey = u.KEY_MAP[orderedHashes[i]];
                        break;
                    }
                }
            }
        }

        if (found.length) {
            const newEntries: Record<string, string> = {};
            for (const f of found) newEntries[f.hash] = f.key;
            u.addToKeyMap(newEntries);
        }

        return { total: allHashes.length, tested, foundCount: found.length, initialUnknown: totalUnknown, remainingUnknown: unknownHashes.size, exhausted, results: found };
    }

    if (action === "unknown") {
        const locale = u.getLocaleMessages();
        if (!locale) return { error: true, message: "Could not find intl definitions module" };

        const hashMap = u.buildIntlHashToKeyMap();
        const allHashes = Object.keys(locale).filter(k => k !== "default" && k !== "__esModule");
        const unknown: Array<{ hash: string; message: string }> = [];
        const filterQuery = query?.toLowerCase();

        for (const h of allHashes) {
            if (hashMap.has(h)) continue;
            const msg = u.extractIntlText(locale[h]);
            if (!msg || msg.length < 2) continue;
            if (filterQuery && !msg.toLowerCase().includes(filterQuery)) continue;
            unknown.push({ hash: h, message: msg.slice(0, 120) });
        }

        unknown.sort((a, b) => a.message.length - b.message.length);
        return { total: allHashes.length, known: allHashes.length - unknown.length, unknownCount: unknown.length, unknown: unknown.slice(0, limit) };
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
            const h = u.runtimeHashMessageKey(candidate);
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
                    expand(idx + 1, current.replaceAll(`{${name}}`, val));
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

        if (found.length) {
            const newEntries: Record<string, string> = {};
            for (const f of found) newEntries[f.hash] = f.key;
            u.addToKeyMap(newEntries);
        }

        return { tested, found, notFound };
    }

    if (action === "neighbors") {
        if (!hash) return u.missingArg("hash");

        const locale = u.getLocaleMessages();
        if (!locale) return { error: true, message: "Could not find intl definitions module" };

        const orderedHashes = u.getOrderedIntlHashes();
        const hashMap = u.buildIntlHashToKeyMap();
        const msg = getMessage(hash);
        const key = hashMap.get(hash);

        const radius = Math.min(limit, 50);

        if (orderedHashes) {
            const idx = orderedHashes.indexOf(hash);
            if (idx === -1) return { error: true, message: `Hash "${hash}" not found in ordered intl module` };

            const neighbors: Array<{ hash: string; key: string | null; message: string | null; position: number }> = [];
            for (let i = Math.max(0, idx - radius); i <= Math.min(orderedHashes.length - 1, idx + radius); i++) {
                if (i === idx) continue;
                const nh = orderedHashes[i];
                neighbors.push({
                    hash: nh,
                    key: hashMap.get(nh) ?? null,
                    message: getMessage(nh)?.slice(0, 120) ?? null,
                    position: i - idx,
                });
            }

            const knownNeighbors = neighbors.filter(n => n.key);
            const unknownNeighbors = neighbors.filter(n => !n.key);
            const commonPrefixes = extractPrefixesFromKeys(knownNeighbors.map(n => n.key!));

            return {
                hash,
                key,
                message: msg?.slice(0, 200),
                position: idx,
                neighbors,
                knownCount: knownNeighbors.length,
                unknownCount: unknownNeighbors.length,
                commonPrefixes: commonPrefixes.slice(0, 20),
                hint: knownNeighbors.length
                    ? `Nearby known keys share these prefixes: ${commonPrefixes.slice(0, 5).join(", ")}. Use intl test with these prefixes combined with words from the message.`
                    : "No known keys nearby. Try bruteforce with hash= first.",
            };
        }

        const allHashes = Object.keys(locale);
        const idx = allHashes.indexOf(hash);
        if (idx === -1) return { hash, key, message: msg, found: false };

        const neighbors: Array<{ hash: string; key: string | null; message: string | null; position: number }> = [];
        for (let i = Math.max(0, idx - radius); i <= Math.min(allHashes.length - 1, idx + radius); i++) {
            if (i === idx) continue;
            const nh = allHashes[i];
            neighbors.push({
                hash: nh,
                key: hashMap.get(nh) ?? null,
                message: getMessage(nh)?.slice(0, 120) ?? null,
                position: i - idx,
            });
        }

        return { hash, key, message: msg?.slice(0, 200), position: idx, neighbors, source: "locale" };
    }

    if (action === "clearCache") {
        u.clearIntlCache();
        return { message: "Intl hash-to-key cache cleared. Next bruteforce/search will rebuild from current KEY_MAP." };
    }

    return { error: true, message: "action: hash, reverse, search, scan, targets, bruteforce, test, unknown, neighbors, clearCache" };
}
