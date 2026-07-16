/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { literalRuns } from "./matchRepair";

export interface UniquenessMargin {
    readonly strength: "strong" | "moderate" | "whole-only";
    readonly minFragmentMatches: number | null;
    readonly distinctiveFragment: string | null;
    readonly detail: string;
}

const MIN_FRAGMENT_LEN = 4;
const FRAGMENT_CAP = 12;
const STRONG_CEILING = 1;
const MODERATE_CEILING = 8;
const SPLIT_CHARS = new Set([...".,()[]{}:;=!&|?"]);

function splitPlainFind(find: string): string[] {
    const parts: string[] = [];
    let cur = "";
    for (const ch of find) {
        if (SPLIT_CHARS.has(ch)) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts;
}

function candidateFragments(find: string, isRegex: boolean): string[] {
    const raw = isRegex ? literalRuns(find, MIN_FRAGMENT_LEN) : splitPlainFind(find);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw) {
        const fragment = part.trim();
        if (fragment.length < MIN_FRAGMENT_LEN || seen.has(fragment)) continue;
        seen.add(fragment);
        out.push(fragment);
        if (out.length === FRAGMENT_CAP) break;
    }
    return out;
}

export function analyzeUniquenessMargin(find: string, isRegex: boolean, countMatches: (fragment: string) => number): UniquenessMargin {
    const fragments = candidateFragments(find, isRegex);
    if (!fragments.length) {
        return {
            strength: "whole-only",
            minFragmentMatches: null,
            distinctiveFragment: null,
            detail: "the find is atomic with no reusable fragment and is unique only as the whole string"
        };
    }

    let distinctiveFragment = fragments[0];
    let minFragmentMatches = countMatches(fragments[0]);
    for (let i = 1; i < fragments.length; i++) {
        const n = countMatches(fragments[i]);
        if (n < minFragmentMatches) {
            minFragmentMatches = n;
            distinctiveFragment = fragments[i];
        }
    }

    if (minFragmentMatches === 0) {
        return {
            strength: "whole-only",
            minFragmentMatches,
            distinctiveFragment,
            detail: "a fragment matched no loaded module, so this uniqueness estimate is unreliable"
        };
    }
    if (minFragmentMatches <= STRONG_CEILING) {
        return {
            strength: "strong",
            minFragmentMatches,
            distinctiveFragment,
            detail: `the fragment "${distinctiveFragment}" is already unique on its own`
        };
    }
    if (minFragmentMatches <= MODERATE_CEILING) {
        return {
            strength: "moderate",
            minFragmentMatches,
            distinctiveFragment,
            detail: `the most distinctive fragment "${distinctiveFragment}" matches ${minFragmentMatches} modules so uniqueness leans on the full anchor`
        };
    }
    return {
        strength: "whole-only",
        minFragmentMatches,
        distinctiveFragment,
        detail: `every fragment matches at least ${minFragmentMatches} modules so the find is unique only as a whole and is more fragile`
    };
}
