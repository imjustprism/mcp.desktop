/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fingerprintSimilarity, type ModuleFingerprint } from "./moduleFingerprint";

export interface FingerprintedModule {
    readonly id: string;
    readonly fp: ModuleFingerprint;
}

export interface ModuleMatch {
    readonly prevId: string;
    readonly currId: string;
    readonly score: number;
    readonly sharedStrong: number;
}

export interface BuildDelta {
    readonly matched: readonly ModuleMatch[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
}

const DEFAULT_MIN_SCORE = 0.34;

function strongKeys(fp: ModuleFingerprint): readonly string[] {
    const keys: string[] = [];
    for (const h of fp.intlHashes) keys.push("i:" + h);
    for (const s of fp.storeNames) keys.push("s:" + s);
    return keys;
}

export function matchAcrossBuilds(
    prev: readonly FingerprintedModule[],
    curr: readonly FingerprintedModule[],
    minScore: number = DEFAULT_MIN_SCORE
): BuildDelta {
    const index = new Map<string, number[]>();
    for (let ci = 0; ci < curr.length; ci++) {
        for (const key of strongKeys(curr[ci].fp)) {
            const bucket = index.get(key);
            if (bucket) bucket.push(ci);
            else index.set(key, [ci]);
        }
    }

    const pairs: ModuleMatch[] = [];
    for (const p of prev) {
        const keys = strongKeys(p.fp);
        const candidates = new Set<number>();
        if (keys.length > 0) {
            for (const key of keys) {
                for (const ci of index.get(key) ?? []) candidates.add(ci);
            }
        } else {
            for (let ci = 0; ci < curr.length; ci++) candidates.add(ci);
        }
        for (const ci of candidates) {
            const sim = fingerprintSimilarity(p.fp, curr[ci].fp);
            if (sim.score < minScore) continue;
            pairs.push({
                prevId: p.id,
                currId: curr[ci].id,
                score: sim.score,
                sharedStrong: sim.sharedIntl + sim.sharedStore
            });
        }
    }

    pairs.sort((a, b) =>
        b.score - a.score ||
        a.prevId.localeCompare(b.prevId) ||
        a.currId.localeCompare(b.currId)
    );

    const takenPrev = new Set<string>();
    const takenCurr = new Set<string>();
    const matched: ModuleMatch[] = [];
    for (const pair of pairs) {
        if (takenPrev.has(pair.prevId) || takenCurr.has(pair.currId)) continue;
        takenPrev.add(pair.prevId);
        takenCurr.add(pair.currId);
        matched.push(pair);
    }

    const added = curr.filter(m => !takenCurr.has(m.id)).map(m => m.id);
    const removed = prev.filter(m => !takenPrev.has(m.id)).map(m => m.id);

    return { matched, added, removed };
}
