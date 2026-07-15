/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { MAX_PERSISTED_KEYS, mergeValidated, serializeKeyMap, validatePersistedEntries } from "./keyMapPersist";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function stubHash(k: string): string {
    let h = 2166136261;
    for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    let n = h >>> 0;
    for (let i = 0; i < 6; i++) { out += alpha[n % 64]; n = Math.floor(n / 64) + i * 7 + 13; }
    return out;
}

check("valid entries whose hash self-verifies are kept", () => {
    const raw = { [stubHash("CLOSE_BUTTON")]: "CLOSE_BUTTON", [stubHash("SAVE_CHANGES")]: "SAVE_CHANGES" };
    const v = validatePersistedEntries(raw, stubHash);
    assert.strictEqual(v.size, 2);
    assert.strictEqual(v.get(stubHash("CLOSE_BUTTON")), "CLOSE_BUTTON");
});

check("entries that fail hash verification are dropped (corrupt or tampered file)", () => {
    const v = validatePersistedEntries({ aB3xZ9: "NOT_THE_RIGHT_KEY" }, stubHash);
    assert.strictEqual(v.size, 0);
});

check("garbage shapes are rejected without throwing", () => {
    for (const raw of [null, 42, "x", [], { bad: 7 }, { "": "" }, { toolong: "x".repeat(200) }]) {
        assert.strictEqual(validatePersistedEntries(raw, stubHash).size, 0);
    }
});

check("malformed hash or key shapes are dropped", () => {
    const good = stubHash("REAL_KEY");
    const v = validatePersistedEntries({ [good]: "REAL_KEY", "bad hash!": "REAL_KEY", [stubHash("lowercase")]: "lowercase" }, stubHash);
    assert.strictEqual(v.size, 1);
});

check("validation is capped at MAX_PERSISTED_KEYS", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < MAX_PERSISTED_KEYS + 50; i++) {
        const key = `KEY_${i}`;
        raw[stubHash(key)] = key;
    }
    const v = validatePersistedEntries(raw, stubHash);
    assert.ok(v.size <= MAX_PERSISTED_KEYS);
});

check("merge only adds hashes absent from the target", () => {
    const target = new Map([[stubHash("EXISTING"), "EXISTING"]]);
    const merged = mergeValidated(target, new Map([[stubHash("EXISTING"), "EXISTING"], [stubHash("FRESH_ONE"), "FRESH_ONE"]]));
    assert.strictEqual(merged, 1);
    assert.strictEqual(target.size, 2);
});

check("serialize round-trips through validate", () => {
    const learned = new Map([[stubHash("ROUND_TRIP"), "ROUND_TRIP"], [stubHash("SECOND_KEY"), "SECOND_KEY"]]);
    const v = validatePersistedEntries(JSON.parse(serializeKeyMap(learned)), stubHash);
    assert.strictEqual(v.size, 2);
});

console.log(`\nall ${passed} checks passed`);
