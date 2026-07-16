/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { isRefString, resolveRefs } from "./refPath";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

check("bracket index ref resolves inside an object", () => {
    const r = resolveRefs({ id: "$0.ids[0]" }, [{ ids: ["A", "B"] }]);
    assert.deepStrictEqual(r, { id: "A" });
});

check("dotted numeric index form resolves", () => {
    const prior = [null, { finds: [{ find: "createBotMessage" }, { find: "sendMessage" }] }];
    const r = resolveRefs({ pattern: "$1.finds.0.find" }, prior);
    assert.deepStrictEqual(r, { pattern: "createBotMessage" });
});

check("whole $0 resolves to the entire prior result", () => {
    const first = { ids: ["A"], count: 1 };
    const r = resolveRefs({ everything: "$0" }, [first]);
    assert.deepStrictEqual(r, { everything: first });
});

check("top level bare ref string resolves", () => {
    const r = resolveRefs("$0.ids", [{ ids: ["A", "B"] }]);
    assert.deepStrictEqual(r, ["A", "B"]);
});

check("string that merely contains a ref passes through unchanged", () => {
    const r = resolveRefs({ note: "$0 dollars", also: "see $1.finds for details" }, [{ ids: [] }, { finds: [] }]);
    assert.deepStrictEqual(r, { note: "$0 dollars", also: "see $1.finds for details" });
});

check("missing path segment resolves to null", () => {
    const r = resolveRefs({ v: "$0.nope.deeper" }, [{ ids: ["A"] }]);
    assert.deepStrictEqual(r, { v: null });
});

check("index past the end of an array resolves to null", () => {
    const r = resolveRefs({ v: "$0.ids[9]" }, [{ ids: ["A"] }]);
    assert.deepStrictEqual(r, { v: null });
});

check("out of range prior result resolves to null", () => {
    const r = resolveRefs({ v: "$5" }, [{ ids: ["A"] }]);
    assert.deepStrictEqual(r, { v: null });
});

check("nested arrays and objects are resolved deeply", () => {
    const prior = [{ moduleId: 1337, exports: ["a", "b"] }, { hits: [10, 20] }];
    const input = {
        calls: [
            { tool: "extract", args: { id: "$0.moduleId", first: "$0.exports[0]" } },
            { tool: "sum", args: { values: ["$1.hits.0", "$1.hits[1]", 30] } }
        ]
    };
    const r = resolveRefs(input, prior);
    assert.deepStrictEqual(r, {
        calls: [
            { tool: "extract", args: { id: 1337, first: "a" } },
            { tool: "sum", args: { values: [10, 20, 30] } }
        ]
    });
});

check("resolved values are inserted without re-resolution", () => {
    const prior = [{ inner: "$0.inner" }];
    const r = resolveRefs({ v: "$0" }, prior);
    assert.deepStrictEqual(r, { v: { inner: "$0.inner" } });
});

check("isRefString accepts valid refs", () => {
    for (const s of ["$0", "$12", "$0.ids", "$0.ids[0]", "$1.finds.0.find", "$2.result.moduleId", "$0._x.$y[3].0"]) {
        assert.strictEqual(isRefString(s), true, `expected ref ${s}`);
    }
});

check("isRefString rejects non refs", () => {
    for (const s of ["", "$", "$x", "0.ids", "$0 dollars", "$0.", "$0.ids[", "$0.ids[a]", "$0.1abc", " $0", "$0 ", "$-1", "$0..ids", "money$0"]) {
        assert.strictEqual(isRefString(s), false, `expected non ref ${s}`);
    }
});

check("numbers booleans and null pass through unchanged", () => {
    const input = { n: 42, f: 1.5, t: true, no: false, nil: null, arr: [0, false, null] };
    const r = resolveRefs(input, [{ ids: [] }]);
    assert.deepStrictEqual(r, input);
});

check("prototype and inherited keys resolve to null", () => {
    const r = resolveRefs({ a: "$0.constructor", b: "$0.__proto__", c: "$0.toString" }, [{ ids: [] }]);
    assert.deepStrictEqual(r, { a: null, b: null, c: null });
});

check("deeply nested structure does not throw and stays partial past the depth cap", () => {
    let deep: unknown = "$0.ids[0]";
    for (let i = 0; i < 50; i++) deep = { child: deep };
    const r = resolveRefs(deep, [{ ids: ["A"] }]) as Record<string, unknown>;
    assert.ok(r && typeof r === "object");
    let cursor: any = r;
    for (let i = 0; i < 50; i++) cursor = cursor.child;
    assert.strictEqual(cursor, "$0.ids[0]");
});

check("shallow refs still resolve when a sibling is too deep", () => {
    let deep: unknown = "$0.ids[1]";
    for (let i = 0; i < 20; i++) deep = [deep];
    const r = resolveRefs({ ok: "$0.ids[0]", deep }, [{ ids: ["A", "B"] }]) as { ok: unknown; };
    assert.strictEqual(r.ok, "A");
});

check("huge flat structure does not throw and respects the node budget", () => {
    const big: string[] = [];
    for (let i = 0; i < 20000; i++) big.push("$0.ids[0]");
    const r = resolveRefs({ big }, [{ ids: ["A"] }]) as { big: string[]; };
    assert.strictEqual(r.big.length, 20000);
    assert.strictEqual(r.big[0], "A");
    assert.strictEqual(r.big[19999], "$0.ids[0]");
});

check("non plain objects pass through untouched", () => {
    const d = new Date(0);
    const r = resolveRefs({ when: d }, [{ ids: [] }]) as { when: Date; };
    assert.strictEqual(r.when, d);
});

console.log(`\nall ${passed} checks passed`);
