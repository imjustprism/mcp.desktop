/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { attributeStack } from "./stackAttribution";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

const multiStack = [
    "TypeError: Cannot read properties of undefined",
    "    at handleClick (WebpackModule4207:12:34)",
    "    at dispatch (WebpackModule4207:99:1)",
    "    at emit (WebpackModule881:5:6)",
    "    at Array.forEach (<anonymous>)",
    "    at https://discord.com/assets/chunk.abc123.js:1:100"
].join("\n");

check("multi-line stack attributes moduleIds per frame", () => {
    const r = attributeStack(multiStack);
    assert.strictEqual(r.frames.length, 5);
    assert.deepStrictEqual(
        r.frames.map(f => f.moduleId),
        ["4207", "4207", "881", null, null]
    );
});

check("topModuleId is the first frame that carries a module id", () => {
    const r = attributeStack(multiStack);
    assert.strictEqual(r.topModuleId, "4207");
});

check("modulesInvolved is de-duplicated and in order", () => {
    const r = attributeStack(multiStack);
    assert.deepStrictEqual(r.modulesInvolved, ["4207", "881"]);
});

check("message line is dropped but raw is preserved for frames", () => {
    const r = attributeStack(multiStack);
    assert.ok(r.frames.every(f => !f.raw.startsWith("TypeError")));
    assert.strictEqual(r.frames[0].raw, "at handleClick (WebpackModule4207:12:34)");
});

check("named function names are extracted", () => {
    const r = attributeStack(multiStack);
    assert.strictEqual(r.frames[0].fn, "handleClick");
    assert.strictEqual(r.frames[1].fn, "dispatch");
    assert.strictEqual(r.frames[3].fn, "Array.forEach");
});

check("anonymous frames yield fn null", () => {
    const r = attributeStack("    at WebpackModule123:1:2\n    at https://discord.com/assets/x.js:3:4");
    assert.strictEqual(r.frames.length, 2);
    assert.strictEqual(r.frames[0].fn, null);
    assert.strictEqual(r.frames[1].fn, null);
    assert.strictEqual(r.frames[0].moduleId, "123");
});

check("resolver is called with the moduleId and its result becomes patchedBy", () => {
    const calls: string[] = [];
    const r = attributeStack(multiStack, id => {
        calls.push(id);
        return id === "4207" ? ["QuickReply"] : null;
    });
    assert.deepStrictEqual(calls, ["4207", "4207", "881"]);
    assert.deepStrictEqual(r.frames[0].patchedBy, ["QuickReply"]);
    assert.deepStrictEqual(r.frames[1].patchedBy, ["QuickReply"]);
    assert.strictEqual(r.frames[2].patchedBy, null);
});

check("resolver returning undefined is normalized to null", () => {
    const r = attributeStack("    at foo (WebpackModule55:1:1)", () => undefined);
    assert.strictEqual(r.frames[0].patchedBy, null);
});

check("frames without a moduleId never consult the resolver", () => {
    const calls: string[] = [];
    const r = attributeStack("    at Array.forEach (<anonymous>)", id => {
        calls.push(id);
        return ["Nope"];
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(r.frames[0].patchedBy, null);
});

check("file:/// and bare WebpackModule forms both parse", () => {
    const r = attributeStack([
        "    at Object.foo (file:///WebpackModule999:1:1)",
        "    at WebpackModule999:2:2",
        "    at bar (webpack-internal:///WebpackModule321:9:9)"
    ].join("\n"));
    assert.deepStrictEqual(
        r.frames.map(f => f.moduleId),
        ["999", "999", "321"]
    );
    assert.strictEqual(r.frames[0].fn, "Object.foo");
    assert.strictEqual(r.frames[2].fn, "bar");
    assert.deepStrictEqual(r.modulesInvolved, ["999", "321"]);
});

check("empty input returns empty frames and null topModuleId without throwing", () => {
    assert.doesNotThrow(() => attributeStack(""));
    const r = attributeStack("");
    assert.deepStrictEqual(r.frames, []);
    assert.strictEqual(r.topModuleId, null);
    assert.deepStrictEqual(r.modulesInvolved, []);
});

check("garbage input returns empty frames without throwing", () => {
    assert.doesNotThrow(() => attributeStack("total nonsense\nnothing frame-like here\n\n   "));
    const r = attributeStack("total nonsense\nnothing frame-like here\n\n   ");
    assert.deepStrictEqual(r.frames, []);
    assert.strictEqual(r.topModuleId, null);
    assert.deepStrictEqual(r.modulesInvolved, []);
});

check("non-string input is tolerated", () => {
    assert.doesNotThrow(() => attributeStack(undefined as unknown as string));
    const r = attributeStack(null as unknown as string);
    assert.deepStrictEqual(r.frames, []);
    assert.strictEqual(r.topModuleId, null);
});

check("Windows CRLF input parses identically to LF", () => {
    const lf = attributeStack(multiStack);
    const crlf = attributeStack(multiStack.replace(/\n/g, "\r\n"));
    assert.strictEqual(crlf.frames.length, lf.frames.length);
    assert.deepStrictEqual(
        crlf.frames.map(f => f.moduleId),
        lf.frames.map(f => f.moduleId)
    );
    assert.strictEqual(crlf.topModuleId, "4207");
    assert.deepStrictEqual(crlf.modulesInvolved, ["4207", "881"]);
});

check("column-only and missing positions do not break parsing", () => {
    const r = attributeStack([
        "    at foo (WebpackModule77:12)",
        "    at bar (WebpackModule78)",
        "    at native"
    ].join("\n"));
    assert.strictEqual(r.frames.length, 3);
    assert.strictEqual(r.frames[0].moduleId, "77");
    assert.strictEqual(r.frames[1].moduleId, "78");
    assert.strictEqual(r.frames[2].moduleId, null);
    assert.deepStrictEqual(r.modulesInvolved, ["77", "78"]);
});

console.log(`\nall ${passed} checks passed`);
