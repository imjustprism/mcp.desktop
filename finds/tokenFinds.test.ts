/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { generateTokenFinds } from "./tokenFinds";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function expandIi(pattern: string): string {
    let out = "";
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === "\\" && pattern[i + 1] === "i") { out += "[A-Za-z_$][\\w$]*"; i += 2; }
        else if (pattern[i] === "\\") { out += pattern[i] + (pattern[i + 1] ?? ""); i += 2; }
        else { out += pattern[i]; i++; }
    }
    return out;
}

check("abstracts minified idents to \\i but keeps the literal string anchor", () => {
    const source = 'l.trackWithMetadata("impression",{page:c})';
    const finds = generateTokenFinds(source);
    assert.ok(finds.length >= 1, "expected at least one find");
    const { find } = finds[0];
    assert.ok(find.includes('\\i\\.trackWithMetadata\\("impression"'), find);
    assert.strictEqual((find.match(/\\i/g) ?? []).length, 2, "l and c should both abstract to \\i");
});

check("emitted pattern with \\i expanded matches the original source", () => {
    const source = 'l.trackWithMetadata("impression",{page:c})';
    const finds = generateTokenFinds(source);
    assert.ok(finds.length >= 1, "expected at least one find");
    for (const f of finds) {
        assert.ok(new RegExp(expandIi(f.find)).test(source), `expanded pattern should match source: ${f.find}`);
    }
});

check("volatile require-call module id never leaks into a find", () => {
    const source = '0,function(e,t,n){var x=n(51234);return"KEEP_THIS_ANCHOR"}';
    const finds = generateTokenFinds(source);
    assert.ok(finds.length >= 1, "the KEEP_THIS_ANCHOR run should still emit a find");
    for (const f of finds) {
        assert.ok(!f.find.includes("51234"), `find must not contain the volatile module id: ${f.find}`);
        assert.ok(new RegExp(expandIi(f.find)).test(source), `expanded pattern should match source: ${f.find}`);
    }
    assert.ok(finds.some(f => f.find.includes("KEEP_THIS_ANCHOR")), "the stable string anchor should survive");
});

check("no degenerate all-\\i or all-punct finds are emitted", () => {
    assert.strictEqual(generateTokenFinds("f(a,b,c)+g(h,i,j)").length, 0, "a run of only short idents has no anchor to emit");
    const mixed = generateTokenFinds('a(b,c);renderSettings("Panel")');
    assert.ok(mixed.length >= 1, "the anchored run should emit");
    for (const f of mixed) {
        const stripped = f.find.replace(/\\i/g, "");
        assert.ok(/[A-Za-z0-9]/.test(stripped), `degenerate find with no literal anchor: ${f.find}`);
    }
});

check("resilience bonus and durability metadata are populated", () => {
    const finds = generateTokenFinds('l.trackWithMetadata("impression",{page:c})');
    const f = finds[0];
    assert.strictEqual(f.tier, "string");
    assert.ok(f.durability >= 6 && f.durability <= 10, `durability ${f.durability} should be scored and bonused`);
    assert.ok(typeof f.score === "number" && f.score > 0, "score should reflect literal content weight");
    assert.ok(f.reasons.some(r => r.includes("\\i metaclass")), "a resilience reason should be present");
});

check("finds are sorted by durability then score and deduped", () => {
    const source = 'l.trackWithMetadata("impression");renderSettings("Panel")';
    const finds = generateTokenFinds(source);
    for (let i = 1; i < finds.length; i++) {
        assert.ok(finds[i - 1].durability >= finds[i].durability, "durability should be non-increasing");
    }
    const patterns = new Set(finds.map(f => f.find));
    assert.strictEqual(patterns.size, finds.length, "patterns should be deduped");
});

console.log(`\nall ${passed} checks passed`);
