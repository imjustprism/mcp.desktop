/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { literalRuns } from "./matchRepair";
import { analyzeUniquenessMargin } from "./uniquenessMargin";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function stub(counts: Record<string, number>, calls?: string[]) {
    return (fragment: string) => {
        calls?.push(fragment);
        return counts[fragment] ?? 999;
    };
}

check("a fragment matching a single module makes the find strong", () => {
    const r = analyzeUniquenessMargin("renderProfileBadges.concat(user)", false, stub({ renderProfileBadges: 1, concat: 40, user: 25 }));
    assert.strictEqual(r.strength, "strong");
    assert.strictEqual(r.minFragmentMatches, 1);
    assert.strictEqual(r.distinctiveFragment, "renderProfileBadges");
    assert.ok(r.detail.includes("renderProfileBadges"));
});

check("all fragments at 4 modules is moderate", () => {
    const r = analyzeUniquenessMargin("openModal(analytics)", false, stub({ openModal: 4, analytics: 4 }));
    assert.strictEqual(r.strength, "moderate");
    assert.strictEqual(r.minFragmentMatches, 4);
    assert.strictEqual(r.distinctiveFragment, "openModal");
    assert.ok(r.detail.includes("4"));
});

check("all fragments common at 50 modules is whole-only", () => {
    const r = analyzeUniquenessMargin("getState().toString()", false, stub({ getState: 50, toString: 50 }));
    assert.strictEqual(r.strength, "whole-only");
    assert.strictEqual(r.minFragmentMatches, 50);
    assert.ok(r.detail.includes("50"));
});

check("a regex find derives its fragments through literalRuns", () => {
    const find = "\\i\\.trackWithMetadata\\(\"impression\"\\)";
    const runs = literalRuns(find, 4);
    assert.ok(runs.length > 0);
    const counts: Record<string, number> = {};
    for (const run of runs) counts[run] = run.includes("trackWithMetadata") ? 1 : 30;
    const calls: string[] = [];
    const r = analyzeUniquenessMargin(find, true, stub(counts, calls));
    assert.deepStrictEqual(calls, runs);
    assert.ok(calls.some(f => f.includes("trackWithMetadata")));
    assert.ok(calls.some(f => f.includes("impression")));
    assert.ok(calls.every(f => !f.includes("\\i")));
    assert.strictEqual(r.strength, "strong");
    assert.strictEqual(r.minFragmentMatches, 1);
    assert.ok(r.distinctiveFragment !== null && r.distinctiveFragment.includes("trackWithMetadata"));
});

check("an atomic find with no long fragment is whole-only with nulls", () => {
    const calls: string[] = [];
    const r = analyzeUniquenessMargin("a=b!c", false, stub({}, calls));
    assert.strictEqual(r.strength, "whole-only");
    assert.strictEqual(r.minFragmentMatches, null);
    assert.strictEqual(r.distinctiveFragment, null);
    assert.strictEqual(calls.length, 0);
    assert.ok(r.detail.length > 0);
});

check("countMatches is never called more than the fragment cap", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${String(i).padStart(2, "0")}`);
    const calls: string[] = [];
    const r = analyzeUniquenessMargin(words.join("."), false, stub({}, calls));
    assert.strictEqual(calls.length, 12);
    assert.deepStrictEqual(calls, words.slice(0, 12));
    assert.notStrictEqual(r.minFragmentMatches, null);
});

check("duplicate fragments are queried only once", () => {
    const calls: string[] = [];
    const r = analyzeUniquenessMargin("getValue.getValue.getValue", false, stub({ getValue: 3 }, calls));
    assert.deepStrictEqual(calls, ["getValue"]);
    assert.strictEqual(r.minFragmentMatches, 3);
});

check("fragments are trimmed and short leftovers are dropped", () => {
    const calls: string[] = [];
    const r = analyzeUniquenessMargin("codePath , ab , dataPath", false, stub({ codePath: 2, dataPath: 9 }, calls));
    assert.deepStrictEqual(calls, ["codePath", "dataPath"]);
    assert.strictEqual(r.strength, "moderate");
    assert.strictEqual(r.distinctiveFragment, "codePath");
});

check("details contain no semicolons and no em or en dashes", () => {
    const results = [
        analyzeUniquenessMargin("renderProfileBadges.concat", false, stub({ renderProfileBadges: 1 })),
        analyzeUniquenessMargin("openModal(analytics)", false, stub({ openModal: 4, analytics: 4 })),
        analyzeUniquenessMargin("getState().toString()", false, stub({ getState: 50, toString: 50 })),
        analyzeUniquenessMargin("a=b", false, stub({}))
    ];
    for (const r of results) {
        assert.ok(!r.detail.includes(";"), r.detail);
        assert.ok(!/[–—]/.test(r.detail), r.detail);
    }
});

check("analysis is deterministic given the same countMatches", () => {
    const counts = { openModal: 4, analytics: 7 };
    const a = analyzeUniquenessMargin("openModal(analytics)", false, stub(counts));
    const b = analyzeUniquenessMargin("openModal(analytics)", false, stub(counts));
    assert.deepStrictEqual(a, b);
});

console.log(`\nall ${passed} checks passed`);
