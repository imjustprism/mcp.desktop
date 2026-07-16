/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { type FingerprintedModule, matchAcrossBuilds } from "./buildDelta";
import type { ModuleFingerprint } from "./moduleFingerprint";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function fp(parts: { intl?: string[]; stores?: string[]; errors?: string[]; css?: string[] }): ModuleFingerprint {
    const intlHashes = parts.intl ?? [];
    const storeNames = parts.stores ?? [];
    const errorStrings = parts.errors ?? [];
    const cssHashes = parts.css ?? [];
    return {
        intlHashes,
        storeNames,
        errorStrings,
        cssHashes,
        landmarkCount: intlHashes.length + storeNames.length + errorStrings.length + cssHashes.length
    };
}

const mod = (id: string, parts: Parameters<typeof fp>[0]): FingerprintedModule => ({ id, fp: fp(parts) });

check("module that kept its intl keys but changed id is matched with high score", () => {
    const prev = [
        mod("82712", { intl: ["Ab12xy", "Cd34zw"], stores: ["QuickSwitcherStore"] }),
        mod("11111", { intl: ["Ee56qq"] })
    ];
    const curr = [
        mod("91004", { intl: ["Ab12xy", "Cd34zw"], stores: ["QuickSwitcherStore"] }),
        mod("22222", { intl: ["Ee56qq"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    const m = delta.matched.find(x => x.prevId === "82712");
    assert.ok(m, "82712 should be matched");
    assert.strictEqual(m.currId, "91004");
    assert.ok(m.score > 0.99, `score ${m.score} should be ~1`);
    assert.strictEqual(m.sharedStrong, 3);
    assert.strictEqual(delta.added.length, 0);
    assert.strictEqual(delta.removed.length, 0);
});

check("genuinely new module with unique landmarks appears in added", () => {
    const prev = [mod("100", { intl: ["Aa11bb"] })];
    const curr = [
        mod("200", { intl: ["Aa11bb"] }),
        mod("999", { intl: ["Zz99yy"], stores: ["BrandNewStore"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    assert.deepStrictEqual([...delta.added], ["999"]);
    assert.strictEqual(delta.matched.length, 1);
    assert.strictEqual(delta.matched[0].currId, "200");
});

check("removed module whose landmarks are gone appears in removed", () => {
    const prev = [
        mod("100", { intl: ["Aa11bb"] }),
        mod("500", { intl: ["Gone01", "Gone02"], stores: ["DeadStore"] })
    ];
    const curr = [mod("200", { intl: ["Aa11bb"] })];
    const delta = matchAcrossBuilds(prev, curr);
    assert.deepStrictEqual([...delta.removed], ["500"]);
    assert.strictEqual(delta.matched.length, 1);
    assert.strictEqual(delta.matched[0].prevId, "100");
});

check("one-to-one: higher score wins the contested module, loser falls to its next candidate", () => {
    const prev = [
        mod("p1", { intl: ["Aaaa11", "Bbbb22"] }),
        mod("p2", { intl: ["Aaaa11", "Bbbb22", "Cccc33"] })
    ];
    const curr = [
        mod("c1", { intl: ["Aaaa11", "Bbbb22"] }),
        mod("c2", { intl: ["Aaaa11", "Cccc33", "Dddd44", "Eeee55"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    const byPrev = new Map(delta.matched.map(m => [m.prevId, m]));
    assert.strictEqual(byPrev.get("p1")?.currId, "c1");
    assert.strictEqual(byPrev.get("p2")?.currId, "c2");
    const currIds = delta.matched.map(m => m.currId);
    assert.strictEqual(new Set(currIds).size, currIds.length, "no curr id claimed twice");
    assert.ok(byPrev.get("p1")!.score > byPrev.get("p2")!.score);
});

check("one-to-one: loser with no other candidate becomes removed", () => {
    const prev = [
        mod("p1", { intl: ["Aaaa11", "Bbbb22"] }),
        mod("p2", { intl: ["Aaaa11"] })
    ];
    const curr = [mod("c1", { intl: ["Aaaa11", "Bbbb22"] })];
    const delta = matchAcrossBuilds(prev, curr);
    assert.strictEqual(delta.matched.length, 1);
    assert.strictEqual(delta.matched[0].prevId, "p1");
    assert.deepStrictEqual([...delta.removed], ["p2"]);
    assert.strictEqual(delta.added.length, 0);
});

check("minScore threshold excludes weak matches by default and admits them when lowered", () => {
    const prev = [mod("p1", { intl: ["Kk11aa", "Kk22bb", "Kk33cc"] })];
    const curr = [mod("c1", { intl: ["Kk11aa", "Xx44dd", "Yy55ee"] })];
    const strict = matchAcrossBuilds(prev, curr);
    assert.strictEqual(strict.matched.length, 0);
    assert.deepStrictEqual([...strict.removed], ["p1"]);
    assert.deepStrictEqual([...strict.added], ["c1"]);
    const loose = matchAcrossBuilds(prev, curr, 0.1);
    assert.strictEqual(loose.matched.length, 1);
    assert.ok(loose.matched[0].score < 0.34);
});

check("empty prev and empty curr do not throw", () => {
    const some = [mod("x", { intl: ["Qq11ww"] })];
    const a = matchAcrossBuilds([], some);
    assert.deepStrictEqual([...a.added], ["x"]);
    assert.strictEqual(a.matched.length, 0);
    assert.strictEqual(a.removed.length, 0);
    const b = matchAcrossBuilds(some, []);
    assert.deepStrictEqual([...b.removed], ["x"]);
    assert.strictEqual(b.matched.length, 0);
    assert.strictEqual(b.added.length, 0);
    const c = matchAcrossBuilds([], []);
    assert.strictEqual(c.matched.length + c.added.length + c.removed.length, 0);
});

check("inverted-index path matches via store names alone", () => {
    const prev = [mod("p1", { stores: ["ThemeStore"] })];
    const curr = [
        mod("c1", { stores: ["ThemeStore"] }),
        mod("c2", { stores: ["OtherStore"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    assert.strictEqual(delta.matched.length, 1);
    assert.strictEqual(delta.matched[0].currId, "c1");
    assert.strictEqual(delta.matched[0].sharedStrong, 1);
});

check("prev module with no strong landmarks falls back to broad compare and still matches", () => {
    const prev = [mod("p1", { errors: ["Something went wrong loading this", "Please try again in a moment"] })];
    const curr = [
        mod("c1", { intl: ["Nn11mm"], stores: ["NoiseStore"] }),
        mod("c2", { errors: ["Something went wrong loading this", "Please try again in a moment"], css: ["container_ab12cd"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    assert.strictEqual(delta.matched.length, 1);
    assert.strictEqual(delta.matched[0].prevId, "p1");
    assert.strictEqual(delta.matched[0].currId, "c2");
    assert.strictEqual(delta.matched[0].sharedStrong, 0);
    assert.deepStrictEqual([...delta.added], ["c1"]);
});

check("matched is sorted by score descending", () => {
    const prev = [
        mod("weak", { intl: ["Ww11ww", "Ww22ww"] }),
        mod("strong", { intl: ["Ss11ss", "Ss22ss"] })
    ];
    const curr = [
        mod("weakC", { intl: ["Ww11ww", "Ww22ww", "Ww33ww", "Ww44ww"] }),
        mod("strongC", { intl: ["Ss11ss", "Ss22ss"] })
    ];
    const delta = matchAcrossBuilds(prev, curr);
    assert.strictEqual(delta.matched.length, 2);
    assert.strictEqual(delta.matched[0].prevId, "strong");
    assert.ok(delta.matched[0].score > delta.matched[1].score);
});

console.log(`\nall ${passed} checks passed`);
