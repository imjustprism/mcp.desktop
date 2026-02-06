/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { search } from "@webpack";

import { getModuleSource, parseRegex } from "./utils";

export async function handleSearchTool(args: Record<string, unknown>): Promise<unknown> {
    const pattern = args.pattern as string | undefined;
    const limit = args.limit as number ?? 10;
    const forceRegex = args.regex as boolean ?? false;

    if (!pattern) return { error: true, message: "pattern required" };

    let regex: RegExp | null;
    try {
        regex = parseRegex(pattern) ?? (forceRegex ? new RegExp(pattern) : null);
    } catch {
        return { error: true, message: `Invalid regex: ${pattern}` };
    }
    if (regex) {
        const searchRegex = regex;
        const matches: Array<{ id: string; match: string; context: string }> = [];
        const results = search(searchRegex);

        for (const id of Object.keys(results)) {
            if (matches.length >= limit) break;

            const source = getModuleSource(id);
            const match = source.match(searchRegex);

            if (match?.index !== undefined) {
                const start = Math.max(0, match.index - 50);
                const end = Math.min(source.length, match.index + match[0].length + 50);
                matches.push({ id, match: match[0].slice(0, 100), context: source.slice(start, end) });
            }
        }

        return { count: matches.length, pattern, matches };
    }

    const results = search(pattern);
    const ids = Object.keys(results).slice(0, limit);

    return {
        count: Object.keys(results).length,
        ids,
        preview: ids.map(id => {
            const source = getModuleSource(id);
            const idx = source.indexOf(pattern);
            if (idx !== -1) {
                const start = Math.max(0, idx - 50);
                const end = Math.min(source.length, idx + pattern.length + 50);
                return { id, snippet: source.slice(start, end) };
            }
            return { id, snippet: source.slice(0, 200) };
        })
    };
}
