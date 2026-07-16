/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { SearchToolArgs, ToolResult } from "../types";
import { search } from "../webpack";
import { CONTEXT, LIMITS } from "./constants";
import * as u from "./utils";

export async function handleSearch(args: SearchToolArgs): Promise<ToolResult> {
    const { pattern, patterns } = args;
    const limit = args.limit ?? LIMITS.SEARCH.DEFAULT_LIMIT;
    const forceRegex = args.regex ?? false;
    if (args.limit !== undefined && args.limit < 1) return { error: true, message: "limit must be >= 1 (omit for default)" };

    if (patterns?.length) {
        if (patterns.length < LIMITS.SEARCH.MIN_PATTERNS) return { error: true, message: `patterns must have at least ${LIMITS.SEARCH.MIN_PATTERNS} entries. Use pattern for single search` };
        if (patterns.length > LIMITS.SEARCH.MAX_PATTERNS) return { error: true, message: `patterns must have at most ${LIMITS.SEARCH.MAX_PATTERNS} entries` };

        const canonPatterns = patterns.map(p => canonicalizeMatch(p));
        const matches: Array<{ id: string; hint?: string | null; matchedPatterns: number; snippets: string[] }> = [];
        let count = 0;

        for (const moduleId of u.getModuleIds()) {
            const source = u.getModuleSource(moduleId);
            if (!canonPatterns.every(p => source.includes(p))) continue;
            count++;
            if (matches.length < limit) {
                const snippets = canonPatterns.map(p => u.snippet(source, source.indexOf(p), p.length, LIMITS.SEARCH.CANON_SNIPPET_BEFORE, LIMITS.SEARCH.CANON_SNIPPET_AFTER));
                matches.push({ id: moduleId, hint: u.getModuleHint(moduleId), matchedPatterns: canonPatterns.length, snippets });
            }
        }

        return { multiPattern: true, patterns, count, matches };
    }

    if (!pattern) return u.missingArg("pattern");

    let regex: RegExp | null;
    try {
        regex = u.parseRegex(pattern) ?? (forceRegex ? new RegExp(pattern) : null);
    } catch {
        return { error: true, message: `Invalid regex: ${pattern}` };
    }
    if (regex) {
        if (/\([^)]*[*+][^)]*\)[*+]/.test(regex.source)) {
            return { error: true, code: "UNSAFE_PATTERN", message: "Pattern has a nested unbounded quantifier that can cause catastrophic backtracking and freeze the client. Rewrite with a bounded {0,N} or remove the outer quantifier" };
        }
        const searchRegex = canonicalizeMatch(regex);

        const indexRegex = u.stripGlobal(searchRegex);
        const matches: Array<{ id: string; hint?: string | null; match: string; context: string }> = [];
        const ids = Object.keys(search(searchRegex));

        for (const id of ids) {
            if (matches.length >= limit) break;

            const source = u.getModuleSource(id);
            const match = source.match(indexRegex);

            if (match?.index !== undefined) {
                matches.push({ id, hint: u.getModuleHint(id), match: match[0].slice(0, LIMITS.SEARCH.MATCH_PREVIEW), context: u.snippet(source, match.index, match[0].length, CONTEXT.SEARCH_SNIPPET, CONTEXT.SEARCH_SNIPPET) });
            }
        }

        return { count: ids.length, pattern, matches };
    }

    const canonicalized = canonicalizeMatch(pattern);
    const keys = Object.keys(search(pattern));
    const ids = keys.slice(0, limit);

    return {
        count: keys.length,
        ids,
        preview: ids.map(id => {
            const source = u.getModuleSource(id);
            return { id, hint: u.getModuleHint(id), snippet: u.snippet(source, source.indexOf(canonicalized), canonicalized.length, CONTEXT.SEARCH_SNIPPET, CONTEXT.SEARCH_SNIPPET) };
        }),
    };
}
