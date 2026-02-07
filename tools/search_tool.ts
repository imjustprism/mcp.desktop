/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { SearchToolArgs } from "../types";
import { search } from "../webpack";
import { CONTEXT } from "./constants";
import { getModuleSource, parseRegex } from "./utils";

export async function handleSearchTool(args: SearchToolArgs): Promise<unknown> {
    const { pattern } = args;
    const limit = args.limit ?? 10;
    const forceRegex = args.regex ?? false;

    if (!pattern) return { error: true, message: "pattern required" };

    let regex: RegExp | null;
    try {
        regex = parseRegex(pattern) ?? (forceRegex ? new RegExp(pattern) : null);
    } catch {
        return { error: true, message: `Invalid regex: ${pattern}` };
    }
    if (regex) {
        const searchRegex = canonicalizeMatch(regex);
        const matches: Array<{ id: string; match: string; context: string }> = [];
        const results = search(searchRegex);

        for (const id of Object.keys(results)) {
            if (matches.length >= limit) break;

            const source = getModuleSource(id);
            const match = source.match(searchRegex);

            if (match?.index !== undefined) {
                const start = Math.max(0, match.index - CONTEXT.SEARCH_SNIPPET);
                const end = Math.min(source.length, match.index + match[0].length + CONTEXT.SEARCH_SNIPPET);
                matches.push({ id, match: match[0].slice(0, 100), context: source.slice(start, end) });
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
            const source = getModuleSource(id);
            const idx = source.indexOf(canonicalized);
            if (idx !== -1) {
                const start = Math.max(0, idx - CONTEXT.SEARCH_SNIPPET);
                const end = Math.min(source.length, idx + canonicalized.length + CONTEXT.SEARCH_SNIPPET);
                return { id, snippet: source.slice(start, end) };
            }
            return { id, snippet: source.slice(0, 200) };
        })
    };
}
