/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { diagnoseMatch, literalRuns } from "./matchRepair";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function expandIi(p: string): string {
    let out = "";
    let i = 0;
    while (i < p.length) {
        if (p[i] === "\\" && p[i + 1] === "i") { out += "(?:[A-Za-z_$][\\w$]*)"; i += 2; }
        else if (p[i] === "\\") { out += p[i] + (p[i + 1] ?? ""); i += 2; }
        else { out += p[i]; i++; }
    }
    return out;
}
const matches = (pattern: string, source: string) => new RegExp(expandIi(pattern)).test(source);

check("direct match reports matches", () => {
    const r = diagnoseMatch("abcXYdef", "abc.{0,3}def");
    assert.strictEqual(r.status, "matches");
    assert.strictEqual(r.failureKind, "matches");
    assert.strictEqual(typeof r.matchIndex, "number");
});

check("gap too narrow is widened to a matching, still-bounded pattern", () => {
    const r = diagnoseMatch(`A${"x".repeat(9)}B`, "A.{0,2}B");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
    assert.ok(r.adjustedPattern && matches(r.adjustedPattern, `A${"x".repeat(9)}B`), "adjusted should match");
    const n = Number(/\{0,(\d+)\}/.exec(r.adjustedPattern!)?.[1]);
    assert.ok(n >= 9, `widened bound ${n} must reach the gap`);
    assert.ok(!/\.\{0,\}|\.\+|\.\*/.test(r.adjustedPattern!), "must stay bounded, never unbounded");
});

check("widening minimizes to needed+slack, not the cap", () => {
    const r = diagnoseMatch(`A${"x".repeat(4)}B`, "A.{0,1}B");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
    const n = Number(/\{0,(\d+)\}/.exec(r.adjustedPattern!)?.[1]);
    assert.ok(n >= 4, `bound ${n} must reach the gap`);
    assert.ok(n < 100, `bound ${n} must be minimized, not left at the cap`);
});

check("stale lookbehind is stripped and the rest matches", () => {
    const r = diagnoseMatch("nowFoo", "(?<=then)Foo");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "lookaround-stale");
    assert.strictEqual(r.adjustedPattern, "Foo");
    assert.ok(matches(r.adjustedPattern!, "nowFoo"));
});

check("stale lookahead is stripped", () => {
    const r = diagnoseMatch("valueX", "value(?=Y)");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "lookaround-stale");
    assert.ok(matches(r.adjustedPattern!, "valueX"));
});

check("missing literals are reported when nothing repairs", () => {
    const r = diagnoseMatch("hello world", "goodbye.{0,5}planet");
    assert.strictEqual(r.status, "unrepaired");
    assert.strictEqual(r.failureKind, "literals-missing");
    assert.deepStrictEqual([...r.missingLiterals].sort(), ["goodbye", "planet"]);
    assert.strictEqual(r.foundLiterals.length, 0);
});

check("found vs missing literals are split correctly", () => {
    const r = diagnoseMatch("the renderThumbnail path", "renderThumbnail.{0,3}absentToken");
    assert.ok(r.foundLiterals.includes("renderThumbnail"));
    assert.ok(r.missingLiterals.includes("absentToken"));
});

check("structure changed when literals present but no gap/lookaround repair applies", () => {
    const r = diagnoseMatch("abcQdef", "abc(?:x|y)def");
    assert.strictEqual(r.status, "unrepaired");
    assert.strictEqual(r.failureKind, "structure-changed");
});

check("\\i minified-identifier placeholder is expanded for matching", () => {
    const r = diagnoseMatch(".myHandler(", "\\.\\i\\(");
    assert.strictEqual(r.failureKind, "matches");
});

check("escaped metacharacters count as literal text", () => {
    const r = diagnoseMatch('{"data-x":true}', '"data\\-x".{0,4}absent');
    assert.ok(r.missingLiterals.includes("absent"));
});

check("adjusted patterns always compile", () => {
    for (const [src, pat] of [[`A${"x".repeat(6)}B`, "A.{0,1}B"], ["zzFoo", "(?<=q)Foo"]] as const) {
        const r = diagnoseMatch(src, pat);
        if (r.adjustedPattern) assert.doesNotThrow(() => new RegExp(expandIi(r.adjustedPattern!)));
    }
});

check("A1: nested-group quantifiers are not widened (no ReDoS hang)", () => {
    const start = Date.now();
    const r = diagnoseMatch("a".repeat(40) + "!", "(a{1,2}){1,2}z");
    assert.ok(Date.now() - start < 2000, "must not hang");
    assert.notStrictEqual(r.status, "repaired");
});

check("A2: {n,m} inside a character class is not treated as a quantifier", () => {
    const r = diagnoseMatch("foo0bar", "foo[{2,5}]bar");
    assert.ok(!(r.adjustedPattern ?? "").includes("480"), "char class must not be widened");
});

check("A3: character-class contents are not reported as literals", () => {
    const r = diagnoseMatch("acats", "[aeiou]cats");
    assert.strictEqual(r.failureKind, "matches");
    assert.ok(!r.missingLiterals.includes("aeiou") && !r.foundLiterals.includes("aeiou"));
});

check("A4: quantifier bounds are not reported as literals", () => {
    const r = diagnoseMatch("hello world", "alpha.{0,500}omega");
    assert.ok(!r.missingLiterals.includes("0,500"));
    assert.ok(r.missingLiterals.includes("alpha") && r.missingLiterals.includes("omega"));
});

check("A5: lookaround openers do not leak into literals", () => {
    const r = diagnoseMatch("has target here", "(?=nope)target");
    for (const l of [...r.foundLiterals, ...r.missingLiterals]) assert.ok(!l.startsWith("=") && !l.startsWith("<="), l);
});

check("A6: stripping to a bare \\i (no literal anchor) is not offered as a repair", () => {
    const r = diagnoseMatch("var abc=123;xyz", "\\i(?=\\?null)");
    assert.ok(r.status !== "repaired" || (r.adjustedPattern ?? "").replace(/\\i/g, "").length >= 4);
});

check("A7: many top-level bounded gaps do not hang (one-at-a-time widening)", () => {
    const src = "A" + "x".repeat(200) + "B" + "y".repeat(200) + "C" + "z".repeat(200) + "D";
    const start = Date.now();
    const r = diagnoseMatch(src, "A.{0,1}B.{0,1}C.{0,1}D");
    assert.ok(Date.now() - start < 3000, "must not hang on multiple narrow gaps");
    assert.ok(r.status === "unrepaired" || r.status === "repaired");
});

check("A8: a paren inside a lookaround character class does not swallow the tail", () => {
    const r = diagnoseMatch("headThing then more", "headThing(?=x[(]y)tailThing");
    assert.ok(!(r.status === "repaired" && !(r.adjustedPattern ?? "").includes("tailThing")));
});

check("A9: many consecutive bounded gaps bail fast instead of ReDoS-hanging", () => {
    const src = "a" + "x".repeat(400) + "b";
    const pattern = "a" + ".{0,1}".repeat(24) + "b";
    const start = Date.now();
    const r = diagnoseMatch(src, pattern);
    assert.ok(Date.now() - start < 3000, `must not hang, took ${Date.now() - start}ms`);
    assert.strictEqual(r.status, "unrepaired");
});

check("A10: a bounded quantifier on the \\i minified-ident shorthand is never widened (no group ReDoS)", () => {
    const start = Date.now();
    const r = diagnoseMatch("b".repeat(35), "\\i{1,3};");
    assert.ok(Date.now() - start < 3000, `must not hang, took ${Date.now() - start}ms`);
    assert.strictEqual(r.status, "unrepaired");
});

check("A11: an escaped literal paren followed by a bounded gap is widenable", () => {
    const r = diagnoseMatch("a)))b", "a\\){0,1}b");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
});

check("A12: a positive lookaround whose literal is absent from source is NOT stripped as stale", () => {
    const r = diagnoseMatch("renderThing(a); renderThing(b)", "renderThing(?=Modal)");
    assert.notStrictEqual(r.status, "repaired");
});

check("A13: a positionally-stale lookaround (literal present elsewhere) is still stripped", () => {
    const r = diagnoseMatch("renderThingXYZ Modal here", "renderThing(?=Modal)");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "lookaround-stale");
});

check("A14: a missing literal in an UNTAKEN alternation branch no longer blocks widening", () => {
    const r = diagnoseMatch("foobarZZZZZZZZTARGET", "(?:foobar|bazqux).{0,3}TARGET");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
});

check("A15: a missing literal in an omitted OPTIONAL group no longer blocks widening", () => {
    const r = diagnoseMatch("startTokenZZZZZZZZendToken", "startToken(?:OPTIONALPART)?.{0,3}endToken");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
});

check("A16: two adjacent stale lookarounds are both stripped", () => {
    const r = diagnoseMatch("x plainword y", "plainword(?=AA)(?=BB)");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "lookaround-stale");
    assert.strictEqual(r.adjustedPattern, "plainword");
});

check("A17: two gaps that must both widen are repaired via uniform multi-widening", () => {
    const r = diagnoseMatch("foo12345bar12345baz", "foo.{0,2}bar.{0,2}baz");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
});

check("A18: stripping refuses when the stripped pattern matches ambiguously (multiple sites)", () => {
    const r = diagnoseMatch("renderThing(a); renderThing(b)", "renderThing(?=Modal)");
    assert.strictEqual(r.status, "unrepaired");
    assert.strictEqual(r.failureKind, "literals-missing");
});

check("A19: a stale lookaround containing a capture group is NOT stripped (would shift $n refs)", () => {
    const r = diagnoseMatch("nowFoo", "(?<=(then))Foo");
    assert.notStrictEqual(r.status, "repaired");
});

check("L1: plain literal runs are emitted split on metacharacters", () => {
    assert.deepStrictEqual(literalRuns("renderThumbnail", 4), ["renderThumbnail"]);
    assert.deepStrictEqual(literalRuns("abcd.efgh", 4), ["abcd", "efgh"]);
});

check("L2: escaped metacharacters count as literal text", () => {
    assert.deepStrictEqual(literalRuns("data\\-x\\.y", 4), ["data-x.y"]);
    assert.deepStrictEqual(literalRuns("foo\\(bar\\)", 4), ["foo(bar)"]);
});

check("L3: character-class contents are not emitted as literals", () => {
    assert.deepStrictEqual(literalRuns("[aeiou]word", 4), ["word"]);
    assert.ok(!literalRuns("pre[abcd]post", 4).includes("abcd"));
});

check("L4: {n,m} quantifier bounds are not emitted as literals", () => {
    assert.deepStrictEqual(literalRuns("alpha.{0,500}omega", 4), ["alpha", "omega"]);
    const runs = literalRuns("token{12,34}next", 4);
    assert.ok(!runs.includes("12,34") && !runs.includes("1234"));
});

check("L5: lookaround openers do not leak into literals", () => {
    for (const run of literalRuns("(?<=then)value(?=Y)", 4)) {
        assert.ok(!/[?=<]/.test(run), run);
    }
    assert.deepStrictEqual(literalRuns("(?=nope)target", 4), ["nope", "target"]);
});

check("L6: minLen threshold drops runs shorter than the bound", () => {
    assert.deepStrictEqual(literalRuns("abcd", 5), []);
    assert.deepStrictEqual(literalRuns("abcd", 4), ["abcd"]);
    assert.deepStrictEqual(literalRuns("ab.cdef", 4), ["cdef"]);
});

check("R1: minified gap-too-narrow widens to reach the real span", () => {
    const src = "var o=n.createElement(t,{className:a,onClick:s},children)";
    const r = diagnoseMatch(src, "createElement\\(t,\\{className:a,.{0,2}\\}");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "gap-too-narrow");
    assert.ok(r.adjustedPattern && matches(r.adjustedPattern, src));
});

check("R2: minified stale lookbehind strips to a unique anchor", () => {
    const src = "e.dispatch({type:UPDATE});return renderSidebar(e)";
    const r = diagnoseMatch(src, "(?<=commit\\()renderSidebar");
    assert.strictEqual(r.status, "repaired");
    assert.strictEqual(r.failureKind, "lookaround-stale");
    assert.strictEqual(r.adjustedPattern, "renderSidebar");
});

check("R3: minified structure change with present literals stays unrepaired", () => {
    const src = "var s=this.state,c=s.count>0?1:0";
    const r = diagnoseMatch(src, "s\\.count[<=]0");
    assert.strictEqual(r.status, "unrepaired");
    assert.strictEqual(r.failureKind, "structure-changed");
    assert.strictEqual(r.missingLiterals.length, 0);
});

console.log(`\nall ${passed} checks passed`);
