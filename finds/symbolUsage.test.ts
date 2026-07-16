/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { extractSymbolUsage, findRequireBindings } from "./symbolUsage";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

check("direct binding is found and property uses are counted", () => {
    const src = "var a=r(123);a.foo();a.foo;a.bar";
    const bindings = findRequireBindings(src, "r", "123");
    assert.deepStrictEqual(bindings, ["a"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "foo", count: 2 }, { prop: "bar", count: 1 }]);
});

check("the (0,a.baz)() sequence call form counts baz", () => {
    const src = "var a=r(55);(0,a.baz)();(0, a.baz)(1,2)";
    const bindings = findRequireBindings(src, "r", "55");
    assert.deepStrictEqual(bindings, ["a"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "baz", count: 2 }]);
});

check("interop n=r.n(e=r(123)) detects both the wrapper and the raw binding", () => {
    const src = "var e,n=r.n(e=r(123));n.thing();e.other";
    const bindings = findRequireBindings(src, "r", "123");
    assert.deepStrictEqual([...bindings].sort(), ["e", "n"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "other", count: 1 }, { prop: "thing", count: 1 }]);
});

check("interop wrapper of an already known binding is also detected", () => {
    const src = "var e=r(77);var n=r.n(e);n.render()";
    const bindings = findRequireBindings(src, "r", "77");
    assert.deepStrictEqual([...bindings].sort(), ["e", "n"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "render", count: 1 }]);
});

check("two different bindings to the same module aggregate their counts", () => {
    const src = "var a=r(9);var b=r(9);a.shared();b.shared();a.only";
    const bindings = findRequireBindings(src, "r", "9");
    assert.deepStrictEqual([...bindings].sort(), ["a", "b"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "shared", count: 2 }, { prop: "only", count: 1 }]);
});

check("unrelated target id yields no bindings", () => {
    const src = "var a=r(123);a.foo";
    assert.deepStrictEqual(findRequireBindings(src, "r", "999"), []);
    assert.deepStrictEqual(findRequireBindings("var a=r(1234);a.foo", "r", "123"), []);
    assert.deepStrictEqual(extractSymbolUsage(src, []), []);
});

check("numeric props are filtered but single-char export names are kept", () => {
    const src = "var a=r(7);a.Z;a.n;a.$1;a._2;a.realExport";
    const bindings = findRequireBindings(src, "r", "7");
    const props = extractSymbolUsage(src, bindings).map(u => u.prop).sort();
    assert.deepStrictEqual(props, ["Z", "n", "realExport"]);
});

check("whitespace tolerance in bindings and property accesses", () => {
    const src = "var a = r ( 123 ) ; a . foo ; a.foo ; var n = r . n ( e = r( 123 ) )";
    const bindings = findRequireBindings(src, "r", "123");
    assert.deepStrictEqual([...bindings].sort(), ["a", "e", "n"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "foo", count: 2 }]);
});

check("mid-identifier and property positions never bind or count", () => {
    const src = "var xa=r(4);obj.a=r(4);var a=r(4);ya.foo;z.a.foo;a.foo";
    const bindings = findRequireBindings(src, "r", "4");
    assert.deepStrictEqual([...bindings].sort(), ["a", "xa"]);
    const usage = extractSymbolUsage(src, ["a"]);
    assert.deepStrictEqual(usage, [{ prop: "foo", count: 1 }]);
});

check("results sort by count descending then prop ascending and cap at 50", () => {
    const props = Array.from({ length: 60 }, (_, i) => `prop${String(i).padStart(2, "0")}`);
    const src = "var a=r(1);" + props.map(p => `a.${p};`).join("") + "a.prop59;a.prop58";
    const bindings = findRequireBindings(src, "r", "1");
    const usage = extractSymbolUsage(src, bindings);
    assert.strictEqual(usage.length, 50);
    assert.deepStrictEqual(usage[0], { prop: "prop58", count: 2 });
    assert.deepStrictEqual(usage[1], { prop: "prop59", count: 2 });
    assert.deepStrictEqual(usage[2], { prop: "prop00", count: 1 });
    assert.deepStrictEqual(usage[49], { prop: "prop47", count: 1 });
});

check("regex metacharacters in the require param are escaped", () => {
    const src = "var a=$(31);a.query;a.query";
    const bindings = findRequireBindings(src, "$", "31");
    assert.deepStrictEqual(bindings, ["a"]);
    const usage = extractSymbolUsage(src, bindings);
    assert.deepStrictEqual(usage, [{ prop: "query", count: 2 }]);
});

console.log(`\nall ${passed} checks passed`);
