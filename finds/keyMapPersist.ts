/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_PERSISTED_KEYS = 20_000;

const HASH_RE = /^[A-Za-z0-9+/]{6}$/;
const KEY_RE = /^[A-Z0-9_$]{2,80}$/;

export function validatePersistedEntries(raw: unknown, hashFn: (key: string) => string): Map<string, string> {
    const out = new Map<string, string>();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    for (const [hash, key] of Object.entries(raw as Record<string, unknown>)) {
        if (out.size >= MAX_PERSISTED_KEYS) break;
        if (typeof key !== "string" || !HASH_RE.test(hash) || !KEY_RE.test(key)) continue;
        if (hashFn(key) !== hash) continue;
        out.set(hash, key);
    }
    return out;
}

export function mergeValidated(target: Map<string, string>, validated: ReadonlyMap<string, string>): number {
    let merged = 0;
    for (const [hash, key] of validated) {
        if (target.has(hash)) continue;
        target.set(hash, key);
        merged++;
    }
    return merged;
}

export function serializeKeyMap(learned: ReadonlyMap<string, string>): string {
    const out: Record<string, string> = {};
    let n = 0;
    for (const [hash, key] of learned) {
        if (n++ >= MAX_PERSISTED_KEYS) break;
        out[hash] = key;
    }
    return JSON.stringify(out);
}
