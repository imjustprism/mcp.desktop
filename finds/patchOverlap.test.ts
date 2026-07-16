/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { simulatePatchOverlaps } from "./patchOverlap";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

const SOURCE = "var a=init();use(a);done(a)";
const wide = { plugin: "WidePlugin", match: "use(a);done(a)", replace: "use(b)" };
const narrow = { plugin: "NarrowPlugin", match: "done(a)", replace: "done(a);log()" };

check("A then B: A destroys B's anchor and it is reported as a conflict", () => {
    const report = simulatePatchOverlaps(SOURCE, [wide, narrow]);
    const [a, b] = report.patches;
    assert.strictEqual(a.plugin, "WidePlugin");
    assert.strictEqual(a.matched, true);
    assert.strictEqual(a.brokenByPrior, false);
    assert.deepStrictEqual(a.span, [13, 27]);
    assert.strictEqual(a.note, "applied cleanly");
    assert.strictEqual(b.plugin, "NarrowPlugin");
    assert.strictEqual(b.matched, false);
    assert.strictEqual(b.span, null);
    assert.strictEqual(b.brokenByPrior, true);
    assert.strictEqual(b.note, "anchor destroyed by an earlier patch");
    assert.strictEqual(report.conflicts, 1);
});

check("B then A: reverse order applies both cleanly with zero conflicts", () => {
    const report = simulatePatchOverlaps(SOURCE, [narrow, wide]);
    for (const r of report.patches) {
        assert.strictEqual(r.matched, true);
        assert.strictEqual(r.brokenByPrior, false);
        assert.strictEqual(r.note, "applied cleanly");
        assert.ok(r.span !== null);
    }
    assert.strictEqual(report.conflicts, 0);
});

check("an anchor absent from the original source is not blamed on prior patches", () => {
    const report = simulatePatchOverlaps(SOURCE, [
        { plugin: "GhostPlugin", match: "neverThere", replace: "whatever" }
    ]);
    const [r] = report.patches;
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.span, null);
    assert.strictEqual(r.brokenByPrior, false);
    assert.strictEqual(r.note, "anchor never present in this module");
    assert.strictEqual(report.conflicts, 0);
});

check("finalSource reflects every applied replacement in order", () => {
    const report = simulatePatchOverlaps(SOURCE, [narrow, wide]);
    assert.strictEqual(report.finalSource, "var a=init();use(b);log()");
});

check("finalSource omits the replacement of a patch that failed to apply", () => {
    const report = simulatePatchOverlaps(SOURCE, [wide, narrow]);
    assert.strictEqual(report.finalSource, "var a=init();use(b)");
});

check("only the first occurrence is replaced, mirroring Vencord", () => {
    const report = simulatePatchOverlaps("hit hit hit", [
        { plugin: "FirstOnly", match: "hit", replace: "hot" }
    ]);
    assert.strictEqual(report.finalSource, "hot hit hit");
    assert.deepStrictEqual(report.patches[0].span, [0, 3]);
});

check("a RegExp match applies with capture group substitution", () => {
    const report = simulatePatchOverlaps(SOURCE, [
        { plugin: "RegexPlugin", match: /done\((\w+)\)/, replace: "done($1,extra)" }
    ]);
    const [r] = report.patches;
    assert.strictEqual(r.matched, true);
    assert.deepStrictEqual(r.span, [20, 27]);
    assert.strictEqual(report.finalSource, "var a=init();use(a);done(a,extra)");
});

check("a passed RegExp keeps its lastIndex across calls", () => {
    const re = /done\((\w+)\)/g;
    re.lastIndex = 7;
    const first = simulatePatchOverlaps(SOURCE, [{ plugin: "Sticky", match: re, replace: "done($1)" }]);
    const second = simulatePatchOverlaps(SOURCE, [{ plugin: "Sticky", match: re, replace: "done($1)" }]);
    assert.strictEqual(re.lastIndex, 7);
    assert.strictEqual(first.patches[0].matched, true);
    assert.strictEqual(second.patches[0].matched, true);
    assert.deepStrictEqual(first.patches[0].span, second.patches[0].span);
});

check("a RegExp anchor destroyed by a prior string patch counts as a conflict", () => {
    const report = simulatePatchOverlaps(SOURCE, [
        wide,
        { plugin: "RegexVictim", match: /done\(a\)/, replace: "gone()" }
    ]);
    assert.strictEqual(report.patches[1].matched, false);
    assert.strictEqual(report.patches[1].brokenByPrior, true);
    assert.strictEqual(report.conflicts, 1);
});

console.log(`\nall ${passed} checks passed`);
