/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { fingerprintModule, fingerprintSimilarity } from "./moduleFingerprint";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

const SNIPPET = 'function(e,t,n){"use strict";var r=n(4234);e.exports=function(i){return r.t.aB3xY9(r.t["Zk9+/2"])};class o extends s{static displayName="UserSettingsStore"}console.error("failed to sync user settings state");var c="container-2xF9pL wrapper__x9Y2kQ"}';

check("extracts intl hashes from dot and bracket access", () => {
    const fp = fingerprintModule(SNIPPET);
    assert.deepStrictEqual([...fp.intlHashes].sort(), ["Zk9+/2", "aB3xY9"]);
});

check("extracts store names from displayName string literals", () => {
    const fp = fingerprintModule(SNIPPET);
    assert.deepStrictEqual(fp.storeNames, ["UserSettingsStore"]);
});

check("extracts human error copy but not short or word-only literals", () => {
    const fp = fingerprintModule(SNIPPET);
    assert.deepStrictEqual(fp.errorStrings, ["failed to sync user settings state"]);
});

check("extracts css hash tokens and keeps them out of error strings", () => {
    const fp = fingerprintModule(SNIPPET);
    assert.deepStrictEqual([...fp.cssHashes].sort(), ["container-2xF9pL", "wrapper__x9Y2kQ"]);
    assert.ok(!fp.errorStrings.some(s => s.includes("container-2xF9pL")));
});

check("landmarkCount totals all sets", () => {
    const fp = fingerprintModule(SNIPPET);
    assert.strictEqual(fp.landmarkCount, 2 + 1 + 1 + 2);
});

check("two builds sharing 2 intl hashes and a store name score high", () => {
    const a = fingerprintModule('x.t.k9Yz2Q&&x.t["Pq7+Rt"];a.displayName="MessageQueueStore";console.warn("queue drained before flush completed")');
    const b = fingerprintModule('v.t.k9Yz2Q;v.t["Pq7+Rt"];b.displayName="MessageQueueStore";console.warn("retrying send after socket closed early")');
    const m = fingerprintSimilarity(a, b);
    assert.strictEqual(m.sharedIntl, 2);
    assert.strictEqual(m.sharedStore, 1);
    assert.strictEqual(m.sharedError, 0);
    assert.ok(m.score > 0.5, `expected high score, got ${m.score}`);
});

check("fully disjoint modules score 0", () => {
    const a = fingerprintModule('x.t.k9Yz2Q;a.displayName="MessageQueueStore";console.warn("queue drained before flush completed")');
    const b = fingerprintModule('q.t.Ab12Cd;r.displayName="VoiceRegionStore";console.error("voice region lookup failed badly")');
    const m = fingerprintSimilarity(a, b);
    assert.strictEqual(m.score, 0);
    assert.strictEqual(m.sharedIntl, 0);
    assert.strictEqual(m.sharedStore, 0);
    assert.strictEqual(m.sharedError, 0);
});

check("identical fingerprints score exactly 1", () => {
    const fp = fingerprintModule(SNIPPET);
    const m = fingerprintSimilarity(fp, fp);
    assert.strictEqual(m.score, 1);
    assert.strictEqual(m.sharedIntl, 2);
    assert.strictEqual(m.sharedStore, 1);
    assert.strictEqual(m.sharedError, 1);
});

check("css hash overlap is weighted below intl overlap of the same size", () => {
    const cssA = fingerprintModule('var c="btn-1a2B3c card_4d5E6f pill__7g8H9i";console.error("alpha path failed to resolve")');
    const cssB = fingerprintModule('var c="btn-1a2B3c card_4d5E6f pill__7g8H9i";console.error("beta path failed to resolve")');
    const intlA = fingerprintModule('x.t.Qw1Er2;x.t.Ty3Ui4;x.t.Op5As6;console.error("alpha path failed to resolve")');
    const intlB = fingerprintModule('y.t.Qw1Er2;y.t.Ty3Ui4;y.t.Op5As6;console.error("beta path failed to resolve")');
    const cssScore = fingerprintSimilarity(cssA, cssB).score;
    const intlScore = fingerprintSimilarity(intlA, intlB).score;
    assert.ok(cssScore > 0, "shared css must still count for something");
    assert.ok(intlScore > cssScore, `intl overlap ${intlScore} must outweigh css overlap ${cssScore}`);
});

check("empty sources do not throw and score 0", () => {
    const a = fingerprintModule("");
    const b = fingerprintModule("");
    assert.strictEqual(a.landmarkCount, 0);
    const m = fingerprintSimilarity(a, b);
    assert.strictEqual(m.score, 0);
});

check("landmark sets are capped at 40 each", () => {
    let big = "";
    for (let i = 0; i < 50; i++) big += `x.t.h${String(i).padStart(5, "0")};`;
    for (let i = 0; i < 45; i++) big += `console.error("things went wrong in branch number ${i}");`;
    const fp = fingerprintModule(big);
    assert.strictEqual(fp.intlHashes.length, 40);
    assert.strictEqual(fp.errorStrings.length, 40);
    assert.strictEqual(fp.landmarkCount, 80);
});

check("landmarks are de-duplicated", () => {
    const fp = fingerprintModule('a.t.Zz9Yx8;b.t.Zz9Yx8;c.displayName="ThemeStore";d.displayName="ThemeStore"');
    assert.strictEqual(fp.intlHashes.length, 1);
    assert.strictEqual(fp.storeNames.length, 1);
});

console.log(`\nall ${passed} checks passed`);
