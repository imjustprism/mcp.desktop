/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface OverlapPatch {
    readonly plugin: string;
    readonly match: string | RegExp;
    readonly replace: string;
}

export interface OverlapResult {
    readonly plugin: string;
    readonly matched: boolean;
    readonly span: readonly [number, number] | null;
    readonly brokenByPrior: boolean;
    readonly note: string;
}

export interface OverlapReport {
    readonly patches: readonly OverlapResult[];
    readonly finalSource: string;
    readonly conflicts: number;
}

interface Span {
    readonly start: number;
    readonly end: number;
}

function cloneRegExp(re: RegExp, flags: string): RegExp {
    return new RegExp(re.source, flags);
}

function findFirst(text: string, match: string | RegExp): Span | null {
    if (typeof match === "string") {
        const idx = text.indexOf(match);
        return idx === -1 ? null : { start: idx, end: idx + match.length };
    }
    const m = cloneRegExp(match, match.flags.replace(/[gy]/g, "")).exec(text);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
}

function applyPatch(text: string, match: string | RegExp, replace: string): string {
    if (typeof match === "string") return text.replace(match, replace);
    return text.replace(cloneRegExp(match, match.flags.replace(/y/g, "")), replace);
}

export function simulatePatchOverlaps(source: string, patches: readonly OverlapPatch[]): OverlapReport {
    let working = source;
    const results: OverlapResult[] = [];
    let conflicts = 0;

    for (const patch of patches) {
        const found = findFirst(working, patch.match);
        if (found) {
            working = applyPatch(working, patch.match, patch.replace);
            results.push({
                plugin: patch.plugin,
                matched: true,
                span: [found.start, found.end],
                brokenByPrior: false,
                note: "applied cleanly"
            });
            continue;
        }
        const wasPresent = findFirst(source, patch.match) !== null;
        if (wasPresent) conflicts++;
        results.push({
            plugin: patch.plugin,
            matched: false,
            span: null,
            brokenByPrior: wasPresent,
            note: wasPresent ? "anchor destroyed by an earlier patch" : "anchor never present in this module"
        });
    }

    return { patches: results, finalSource: working, conflicts };
}
