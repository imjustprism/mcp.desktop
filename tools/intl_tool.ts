/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

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

interface PatternData {
    starters: string[];
    transitions: Map<string, string[]>;
    parts: string[];
    prefixes: string[];
    prefixes2: string[];
    suffixes: string[];
    suffixes2: string[];
}

let patternCache: PatternData | null = null;

function buildPatternData(): PatternData {
    if (patternCache) return patternCache;

    const starterCounts = new Map<string, number>();
    const transitionCounts = new Map<string, Map<string, number>>();
    const partCounts = new Map<string, number>();
    const prefixCounts = new Map<string, number>();
    const prefix2Counts = new Map<string, number>();
    const suffixCounts = new Map<string, number>();
    const suffix2Counts = new Map<string, number>();

    for (const key of Object.values(KEY_MAP)) {
        const segments = key.split("_");
        if (!segments.length) continue;

        const first = segments[0];
        starterCounts.set(first, (starterCounts.get(first) ?? 0) + 1);

        for (let i = 0; i < segments.length - 1; i++) {
            const from = segments[i];
            const to = segments[i + 1];
            if (!transitionCounts.has(from)) transitionCounts.set(from, new Map());
            const toMap = transitionCounts.get(from)!;
            toMap.set(to, (toMap.get(to) ?? 0) + 1);
        }

        for (const seg of segments) {
            if (seg.length >= 2) partCounts.set(seg, (partCounts.get(seg) ?? 0) + 1);
        }

        if (segments.length >= 2) {
            prefixCounts.set(first, (prefixCounts.get(first) ?? 0) + 1);
            const last = segments[segments.length - 1];
            suffixCounts.set(last, (suffixCounts.get(last) ?? 0) + 1);
        }

        if (segments.length >= 3) {
            const p2 = segments.slice(0, 2).join("_");
            prefix2Counts.set(p2, (prefix2Counts.get(p2) ?? 0) + 1);
            const s2 = segments.slice(-2).join("_");
            suffix2Counts.set(s2, (suffix2Counts.get(s2) ?? 0) + 1);
        }
    }

    const sortByFrequency = (counts: Map<string, number>, min = 2) =>
        [...counts.entries()]
            .filter(([, count]) => count >= min)
            .sort((a, b) => b[1] - a[1])
            .map(([key]) => key);

    const transitions = new Map<string, string[]>();
    for (const [from, toMap] of transitionCounts) {
        transitions.set(from, sortByFrequency(toMap, 1));
    }

    patternCache = {
        starters: sortByFrequency(starterCounts, 1),
        transitions,
        parts: sortByFrequency(partCounts, 1),
        prefixes: sortByFrequency(prefixCounts, 2),
        prefixes2: sortByFrequency(prefix2Counts, 2),
        suffixes: sortByFrequency(suffixCounts, 2),
        suffixes2: sortByFrequency(suffix2Counts, 2),
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

function* generateCandidates(words: string[], patterns: PatternData): Generator<string> {
    if (!words.length) return;

    for (const word of words) yield word;

    for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
            yield words.slice(i, j).join("_");
        }
    }

    for (const starter of patterns.starters) {
        yield starter;
        for (const word of words) {
            yield `${starter}_${word}`;

            const next = patterns.transitions.get(starter);
            if (!next) continue;

            for (const n1 of next.slice(0, 30)) {
                yield `${starter}_${n1}`;
                yield `${starter}_${n1}_${word}`;
                yield `${starter}_${word}_${n1}`;

                const next2 = patterns.transitions.get(n1);
                if (!next2) continue;

                for (const n2 of next2.slice(0, 20)) {
                    yield `${starter}_${n1}_${n2}`;
                    yield `${starter}_${n1}_${n2}_${word}`;
                }
            }
        }
    }

    for (const word of words) {
        const next = patterns.transitions.get(word);
        if (next) {
            for (const n1 of next.slice(0, 60)) {
                yield `${word}_${n1}`;

                const next2 = patterns.transitions.get(n1);
                if (!next2) continue;

                for (const n2 of next2.slice(0, 30)) {
                    yield `${word}_${n1}_${n2}`;

                    const next3 = patterns.transitions.get(n2);
                    if (!next3) continue;

                    for (const n3 of next3.slice(0, 15)) {
                        yield `${word}_${n1}_${n2}_${n3}`;
                    }
                }
            }
        }

        for (const starter of patterns.starters) {
            const chain = patterns.transitions.get(starter);
            if (!chain?.includes(word)) continue;

            yield `${starter}_${word}`;

            const after = patterns.transitions.get(word);
            if (!after) continue;

            for (const a1 of after.slice(0, 40)) {
                yield `${starter}_${word}_${a1}`;

                const after2 = patterns.transitions.get(a1);
                if (!after2) continue;

                for (const a2 of after2.slice(0, 20)) {
                    yield `${starter}_${word}_${a1}_${a2}`;
                }
            }
        }
    }

    for (const pre of patterns.prefixes.slice(0, 400)) {
        for (const word of words) yield `${pre}_${word}`;
    }

    for (const pre of patterns.prefixes2.slice(0, 300)) {
        for (const word of words) yield `${pre}_${word}`;
    }

    for (const word of words) {
        for (const suf of patterns.suffixes.slice(0, 300)) yield `${word}_${suf}`;
        for (const suf of patterns.suffixes2.slice(0, 250)) yield `${word}_${suf}`;
    }

    for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) {
            const core = words.slice(i, j).join("_");
            for (const pre of patterns.prefixes.slice(0, 300)) yield `${pre}_${core}`;
            for (const pre of patterns.prefixes2.slice(0, 250)) yield `${pre}_${core}`;
            for (const suf of patterns.suffixes.slice(0, 250)) yield `${core}_${suf}`;
            for (const suf of patterns.suffixes2.slice(0, 150)) yield `${core}_${suf}`;
        }
    }

    for (const pre of patterns.prefixes.slice(0, 200)) {
        for (const word of words) {
            for (const suf of patterns.suffixes.slice(0, 150)) {
                yield `${pre}_${word}_${suf}`;
            }
        }
    }

    for (const pre of patterns.prefixes2.slice(0, 150)) {
        for (const word of words) {
            for (const suf of patterns.suffixes.slice(0, 120)) {
                yield `${pre}_${word}_${suf}`;
            }
        }
    }

    for (const pre of patterns.prefixes.slice(0, 150)) {
        for (const word of words) {
            for (const suf of patterns.suffixes2.slice(0, 120)) {
                yield `${pre}_${word}_${suf}`;
            }
        }
    }

    for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j <= Math.min(words.length, i + 2); j++) {
            const core = words.slice(i, j).join("_");
            for (const pre of patterns.prefixes.slice(0, 120)) {
                for (const suf of patterns.suffixes.slice(0, 100)) {
                    yield `${pre}_${core}_${suf}`;
                }
            }
        }
    }

    for (const word of words) {
        const stack: string[][] = [[word]];
        const seen = new Set<string>();

        while (stack.length) {
            const path = stack.pop()!;
            if (path.length > 5) continue;

            const current = path[path.length - 1];
            const next = patterns.transitions.get(current);
            if (!next) continue;

            for (const n of next.slice(0, 10)) {
                const newPath = [...path, n];
                const candidate = newPath.join("_");
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                yield candidate;
                stack.push(newPath);
            }
        }
    }

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

export async function handleIntlTool(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action as string | undefined;
    const key = args.key as string | undefined;
    const hash = args.hash as string | undefined;
    const hashes = args.hashes as string[] | undefined;
    const query = args.query as string | undefined;
    const moduleId = args.moduleId as string | undefined;
    const limit = (args.limit as number) ?? 20;

    const candidates = args.candidates as string[] | undefined;
    const prefixes = args.prefixes as string[] | undefined;
    const suffixes = args.suffixes as string[] | undefined;
    const mids = args.mids as string[] | undefined;
    const pattern = args.pattern as string | undefined;
    const parts = args.parts as Record<string, string[]> | undefined;

    if (action === "hash" || (key && !action)) {
        if (!key) return { error: true, message: "key required" };
        const h = runtimeHashMessageKey(key);
        return { key, hash: h, find: `#{intl::${key}}`, message: getMessage(h) };
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

            const entry: { hash: string; message: string; key?: string } = {
                hash: h,
                message: text.slice(0, 200)
            };
            const known = hashMap.get(h);
            if (known) entry.key = known;

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
            /\.t\.([A-Za-z0-9+/]{6})/g,
            /\.t\["([A-Za-z0-9+/]{6})"\]/g,
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

        const results = [...found].map(h => ({ hash: h, message: getMessage(h) }));
        return { moduleId, count: found.size, hashes: results };
    }

    if (action === "targets") {
        if (!key) return { error: true, message: "key required" };
        const h = runtimeHashMessageKey(key);
        return {
            key,
            hash: h,
            message: getMessage(h),
            modules: searchModulesOptimized(src => src.includes(h), limit)
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

    return { error: true, message: "action: hash, reverse, search, scan, targets, bruteforce, or test" };
}
