/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { SearchToolArgs } from "../types";
import { search } from "../webpack";
import { CONTEXT } from "./constants";
import * as u from "./utils";

export async function handleSearchTool(args: SearchToolArgs): Promise<unknown> {
    const { pattern, patterns } = args;
    const limit = args.limit ?? 10;
    const forceRegex = args.regex ?? false;

    if (patterns?.length) {
        if (patterns.length < 2) return { error: true, message: "patterns needs at least 2 entries, use pattern for single search" };
        if (patterns.length > 10) return { error: true, message: "Max 10 patterns" };

        const canonPatterns = patterns.map(p => canonicalizeMatch(p));
        const matches: Array<{ id: string; hint?: string | null; matchedPatterns: number; snippets: string[] }> = [];

        for (const moduleId of u.getModuleIds()) {
            if (matches.length >= limit) break;
            const source = u.getModuleSource(moduleId);
            if (canonPatterns.every(p => source.includes(p))) {
                const snippets = canonPatterns.map(p => {
                    const idx = source.indexOf(p);
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(source.length, idx + p.length + 50);
                    return source.slice(start, end);
                });
                matches.push({ id: moduleId, hint: u.getModuleHint(moduleId), matchedPatterns: canonPatterns.length, snippets });
            }
        }

        return { multiPattern: true, patterns, count: matches.length, matches };
    }

    if (!pattern) return u.missingArg("pattern");

    let regex: RegExp | null;
    try {
        regex = u.parseRegex(pattern) ?? (forceRegex ? new RegExp(pattern) : null);
    } catch {
        return { error: true, message: `Invalid regex: ${pattern}` };
    }
    if (regex) {
        const searchRegex = canonicalizeMatch(regex);
        const matches: Array<{ id: string; hint?: string | null; match: string; context: string }> = [];
        const results = search(searchRegex);

        for (const id of Object.keys(results)) {
            if (matches.length >= limit) break;

            const source = u.getModuleSource(id);
            const match = source.match(searchRegex);

            if (match?.index !== undefined) {
                const start = Math.max(0, match.index - CONTEXT.SEARCH_SNIPPET);
                const end = Math.min(source.length, match.index + match[0].length + CONTEXT.SEARCH_SNIPPET);
                matches.push({ id, hint: u.getModuleHint(id), match: match[0].slice(0, 100), context: source.slice(start, end) });
            }
        }

        return { count: matches.length, pattern, matches };
    }

    const canonicalized = canonicalizeMatch(pattern);
    const results = search(pattern);
    const ids = Object.keys(results).slice(0, limit);

    return {
        count: Object.keys(results).length,
        ids,
        preview: ids.map(id => {
            const source = u.getModuleSource(id);
            const idx = source.indexOf(canonicalized);
            const hint = u.getModuleHint(id);
            if (idx !== -1) {
                const start = Math.max(0, idx - CONTEXT.SEARCH_SNIPPET);
                const end = Math.min(source.length, idx + canonicalized.length + CONTEXT.SEARCH_SNIPPET);
                return { id, hint, snippet: source.slice(start, end) };
            }
            return { id, hint, snippet: source.slice(0, 200) };
        }),
    };
}
