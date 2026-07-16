/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreDurability } from "./durability";
import { computeVolatileSpans, detectRequireParam, generateFinds } from "./genFinds";
import { tokenize, tokenText } from "./tokenizer";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "__fixtures__", "module-96782.txt"), "utf8");

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;

    console.log(`  ok  ${name}`);
}

function kinds(src: string) {
    return tokenize(src).map(t => `${t.kind}:${tokenText(src, t)}`);
}

check("regex literal after '=' is one regex token", () => {
    const ks = kinds("x=/ab+c/gi");
    assert.ok(ks.includes("regex:/ab+c/gi"), ks.join(" | "));
});

check("slash after identifier is division, not regex", () => {
    const toks = tokenize("a/b");
    assert.strictEqual(toks.length, 3);
    assert.strictEqual(toks[1].kind, "punct");
    assert.strictEqual(tokenText("a/b", toks[1]), "/");
});

check("slash after ')' is division", () => {
    const src = "f(x)/2";
    const div = tokenize(src).find(t => t.kind === "punct" && tokenText(src, t) === "/");
    assert.ok(div, "expected a division punct");
});

check("line and block comments are skipped", () => {
    assert.deepStrictEqual(kinds("a/*c*/b//tail"), ["ident:a", "ident:b"]);
});

check("string with escaped quote is a single token", () => {
    const src = '"a\\"b"';
    const toks = tokenize(src);
    assert.strictEqual(toks.length, 1);
    assert.strictEqual(toks[0].kind, "str");
    assert.strictEqual(toks[0].end, src.length);
});

check("nested template holes tokenize inner idents separately", () => {
    const src = "`a${bcdef?`x${ghijk}y`:z}b`";
    const ks = kinds(src);
    assert.ok(ks.includes("ident:bcdef"), ks.join(" | "));
    assert.ok(ks.includes("ident:ghijk"), ks.join(" | "));
    assert.ok(ks.some(k => k.startsWith("template:")), ks.join(" | "));
});

check("template with no holes is one template token", () => {
    const toks = tokenize("`plain text`");
    assert.strictEqual(toks.length, 1);
    assert.strictEqual(toks[0].kind, "template");
});

check("detects webpack require param from header", () => {
    assert.strictEqual(detectRequireParam(fixture), "i");
});

check("bad spans cover the side-effect and import module ids", () => {
    const spans = computeVolatileSpans(fixture, "i");
    const covers = (needle: string) => {
        const idx = fixture.indexOf(needle);
        return spans.some(([s, e]) => idx >= s && idx < e);
    };
    assert.ok(covers("627968"), "import id 627968 not excluded");
    assert.ok(covers("938796"), "side-effect id 938796 not excluded");
    assert.ok(covers("321073"), "side-effect id 321073 not excluded");
});

const MODULE_IDS = ["938796", "321073", "627968", "64700", "503698", "665260", "990078", "838541", "652215", "375708"];

check("no generated find embeds a volatile module id or require call", () => {
    const finds = generateFinds(fixture, { limit: 500 });
    assert.ok(finds.length > 0, "expected some finds");
    for (const f of finds) {
        assert.ok(!/i\(\d{3,}\)/.test(f.find), `find embeds a require call: ${f.find}`);
        for (const id of MODULE_IDS) {
            assert.ok(!f.find.includes(id), `find embeds module id ${id}: ${f.find}`);
        }
    }
});

check("enumerates the distinctive 'remove' icon-button run", () => {
    const finds = generateFinds(fixture, { limit: 1000 });
    assert.ok(
        finds.some(f => f.find.includes('color:"currentColor",width:20,height:20')),
        "expected the currentColor/width/height run among candidates"
    );
});

check("surfaces intl accesses as canonical #{intl::KEY} finds, ranked first", () => {
    const map: Record<string, string> = {
        Y8ujqr: "EDIT_ATTACHMENT_TOOLTIP",
        "/XT3ij": "REMOVE_ATTACHMENT_TOOLTIP_TEXT",
        "0+xZH0": "REMOVE",
        "1WjMbC": "DOWNLOAD"
    };
    const finds = generateFinds(fixture, { hashToKey: h => map[h] ?? null, limit: 1000 });
    const intl = finds.filter(f => f.type === "intl");
    assert.ok(intl.some(f => f.find === "#{intl::REMOVE_ATTACHMENT_TOOLTIP_TEXT}"), "missing canonical intl find");
    assert.strictEqual(finds[0].type, "intl", "intl finds should rank first");
    assert.strictEqual(finds[0].durability, 10);
    for (const f of finds) assert.ok(!/#\{intl::[A-Za-z0-9+/]{6}\}/.test(f.find) || /[A-Z_]/.test(f.find), f.find);
});

check("isUnique filter keeps only unique finds and flags them", () => {
    const finds = generateFinds(fixture, { isUnique: f => f.includes('color:"currentColor"'), limit: 1000 });
    assert.ok(finds.length > 0, "expected at least one 'unique' find");
    for (const f of finds) {
        assert.strictEqual(f.unique, true);
        assert.ok(f.find.includes('color:"currentColor"'));
    }
});

check("results are sorted by durability then score", () => {
    const finds = generateFinds(fixture, { limit: 1000 });
    for (let i = 1; i < finds.length; i++) {
        const a = finds[i - 1];
        const b = finds[i];
        assert.ok(a.durability > b.durability || (a.durability === b.durability && a.score >= b.score), `sort broken at ${i}`);
    }
});

check("durability ranks anchors intl > store > raw-hash > module-id-laden", () => {
    const intl = scoreDurability("#{intl::REMOVE}").score;
    const store = scoreDurability('="UserSettingsProtoStore"').score;
    const raw = scoreDurability(".t.Y8ujqr").score;
    const idLaden = scoreDurability("i(627968)").score;
    assert.strictEqual(scoreDurability("#{intl::REMOVE}").tier, "intl");
    assert.strictEqual(intl, 10);
    assert.ok(store >= 8, `store ${store}`);
    assert.ok(raw < intl, `raw ${raw} should be < intl ${intl}`);
    assert.ok(idLaden <= 3, `id-laden ${idLaden} should be low`);
    assert.ok(store > idLaden);
});

check("css hash suffix is penalized", () => {
    const withHash = scoreDurability('className:"container_a1b2c3"').score;
    const without = scoreDurability('className:"container"').score;
    assert.ok(withHash < without, `${withHash} !< ${without}`);
});

check("empty and trivial sources do not throw and embed no require calls", () => {
    assert.deepStrictEqual(generateFinds(""), []);
    const tiny = "0,function(e,t,n){e.exports=n(1)}";
    const finds = generateFinds(tiny, { limit: 50 });
    for (const f of finds) assert.ok(!f.find.includes("n(1)"), f.find);
});

function noLeak(src: string, ids: string[]) {
    for (const f of generateFinds(src, { minScore: 0, limit: 500 })) {
        for (const id of ids) assert.ok(!f.find.includes(id), `find leaks ${id}: ${f.find}`);
    }
}

check("R1: division after postfix ++/-- is not a runaway regex (no id leak)", () => {
    const src = '0,(e,t,n)=>{var s=t.retryCount++/2,cfg=n(51234),z=e.ratio/e.total;s.trackMetric("stableNeedleStringHere")}';
    const div = tokenize("a++/b").find(t => t.kind === "punct" && tokenText("a++/b", t) === "/");
    assert.ok(div, "slash after ++ should be division punct");
    noLeak(src, ["51234"]);
});

check("R2: reserved-word property (.default/) does not trigger a regex that leaks an id", () => {
    const src = '0,(e,t,n)=>{var r=e.default/1e3,cfg=n(42871),lbl=e.title/e.span;r.report("stableAnchorString")}';
    noLeak(src, ["42871"]);
});

check("R3: regex at a template-hole start does not leak a require id", () => {
    const src = "0,(e,t,n)=>{return`x${/[\"']/.test(e)?t:n(70321)}y`}";
    noLeak(src, ["70321"]);
});

check("R4: webpack .t(id) namespace require is excluded", () => {
    const src = "0,function(e,t,i){i.d(t,{Ay:()=>P});function P(e){return i.t(415779,7).createStore(e)}}";
    const spans = computeVolatileSpans(src, "i");
    const idx = src.indexOf("415779");
    assert.ok(spans.some(([s, e]) => idx >= s && idx < e), ".t(id) not span-excluded");
    noLeak(src, ["415779"]);
});

check("R5: a string overlapping a bad span does not leak the require call", () => {
    const src = '0,function(e,t,n){var s=n(627968);return o.jsx("code",{value:"see n(100003)"})}';
    noLeak(src, ["n(100003)", "627968"]);
});

check("R6: real Discord CSS hash formats are penalized and rank below stable names", () => {
    const plain = scoreDurability('"container"').score;
    for (const cls of ['"container-2sxwvC"', '"avatarStack_a8Zx1q"', '"container_d59d0d"']) {
        assert.ok(scoreDurability(cls).score < plain, `${cls} not penalized`);
    }
    const finds = generateFinds('x "container-2sxwvC" y "GuildTextChannel" z', { minScore: 1 });
    const css = finds.find(f => f.find.includes("2sxwvC"));
    const name = finds.find(f => f.find.includes("GuildTextChannel"));
    assert.ok(css && name && name.durability > css.durability, "durable name should outrank per-build css hash");
});

check("R7: single-token PascalCase string is not penalized as prose", () => {
    const d = scoreDurability('"GuildTextChannel"');
    assert.strictEqual(d.score, 6);
    assert.ok(!d.reasons.some(r => r.includes("plain English")));
});

check("R8: intl hashes ending in + or / still yield a canonical #{intl::KEY}", () => {
    const map: Record<string, string> = { "aB3d1/": "REPLY_QUOTE_TITLE", "aB3d1+": "CALL_RINGING_TITLE" };
    for (const [hash, key] of Object.entries(map)) {
        const finds = generateFinds(`n.default.t.${hash})`, { hashToKey: h => map[h] ?? null, minScore: 1 });
        assert.ok(finds.some(f => f.find === `#{intl::${key}}`), `missed intl hash ${hash}`);
    }
    assert.strictEqual(scoreDurability(".t.aB3d1/").tier, "intl");
});

check("R9: numbers inside error/log copy are not penalized as module ids", () => {
    const d = scoreDurability('"Maximum number of server folders reached (100)"');
    assert.strictEqual(d.tier, "errorString");
    assert.ok(d.score >= 7, `error string over-penalized: ${d.score}`);
});

check("R10: unterminated string bails at newline instead of swallowing to EOF", () => {
    const src = '"ab\ncd"';
    const first = tokenize(src)[0];
    assert.strictEqual(first.kind, "str");
    assert.ok(first.end < src.length, "string should not swallow past the newline");
});

check("R11: all-letter mixed-case base62 CSS hash is penalized below a durable anchor", () => {
    const cssBlob = scoreDurability('"wrapper-oMFrIy hiddenInput-KpXnwT"');
    assert.ok(cssBlob.score <= 4, `mixed-case css hash not penalized: ${cssBlob.score}`);
    const durable = scoreDurability('.dispatchToLastSubscribed("USER_PROFILE_MODAL_OPEN")');
    assert.ok(durable.score > cssBlob.score, `durable(${durable.score}) should outrank css blob(${cssBlob.score})`);
});

check("R12: generateFinds is linear on a large single-string module (no ReDoS hang)", () => {
    const blob = "abcd-".repeat(40000);
    const src = `0,(e,t,n)=>{const B="${blob}";return B}`;
    const start = Date.now();
    generateFinds(src, { limit: 20 });
    const ms = Date.now() - start;
    assert.ok(ms < 4000, `generateFinds took ${ms}ms (possible ReDoS/quadratic scan)`);
});

check("R13: webpackId:<id> property beside a lazy bind does not leak the module id", () => {
    const src = '0,function(e,t,n){t.exports=e=>Promise.all([n.e("99193")]).then(n.bind(n,888250)),webpackId:888250,name:"AppOverlay"}';
    const spans = computeVolatileSpans(src, "n");
    const idx = src.indexOf("webpackId:888250");
    assert.ok(spans.some(([s, ee]) => idx >= s && idx < ee), "webpackId:id not span-excluded");
    noLeak(src, ["888250", "webpackId:888250"]);
});

check("R14: CSS name__hash (double underscore) class value is penalized", () => {
    const withHash = scoreDurability('="container__3b95d"').score;
    const without = scoreDurability('="container"').score;
    assert.ok(withHash < without, `${withHash} !< ${without}`);
    const blob = scoreDurability('"mention__3b95d active__3b95d"').score;
    const durable = scoreDurability('="MessageStore"').score;
    assert.ok(durable > blob, `store(${durable}) should outrank css blob(${blob})`);
});

check("R15: content-hash CDN url / asset filename is penalized as volatile", () => {
    const cdn = scoreDurability('"https://cdn.discordapp.com/assets/content/c0f100da7d39f5e84ae361150c05077f9ca94ea62d0f7dd086ba1aa8fe17ae68.mov"').score;
    const woff = scoreDurability('+"7b652d8bbf885aea.woff2"').score;
    const plain = scoreDurability('"MessageActionCreators"').score;
    assert.ok(cdn < plain, `cdn(${cdn}) should be < plain string(${plain})`);
    assert.ok(woff < plain, `woff hash(${woff}) should be < plain string(${plain})`);
});

check("R16: 'use strict' prologue is not treated as a durable error string", () => {
    const d = scoreDurability('){"use strict";');
    assert.notStrictEqual(d.tier, "errorString");
    assert.ok(d.score <= 5, `use strict over-scored: ${d.score}`);
});

check("R17: exotic whitespace separates idents; ZWJ joins within an ident", () => {
    assert.deepStrictEqual(kinds("a\u00a0b"), ["ident:a", "ident:b"]);
    assert.deepStrictEqual(kinds("a\ufeffb"), ["ident:a", "ident:b"]);
    assert.strictEqual(tokenize("ab\u200dcd").length, 1);
});

check("R18: pair synthesis is off by default (no 'pair' finds)", () => {
    const finds = generateFinds(fixture, { hashToKey: () => null, limit: 1000 });
    assert.ok(finds.every(f => f.type !== "pair"), "no pair finds without the opt-in");
});

check("R19: synthesizePairs joins two fragments with a bounded, leak-free, self-valid regex", () => {
    const src = '0,function(e,t,n){var a=n(627968);return o.jsx("StableAnchorAlpha",{x:e.foo,y:t.bar},"StableAnchorBeta")}';
    const finds = generateFinds(src, { synthesizePairs: true, minScore: 0, limit: 500 });
    const pair = finds.find(f => f.type === "pair");
    assert.ok(pair, "expected a synthesized pair find");
    assert.strictEqual(pair!.regex, true);
    assert.ok(/\{0,\d+\}/.test(pair!.find), "gap must be bounded");
    assert.ok(!/(?<!\\)[*+]/.test(pair!.find), "gap must never be unbounded");
    assert.ok(!pair!.find.includes("627968") && !/n\(\d+\)/.test(pair!.find), "no volatile id may leak into a pair");
    assert.ok(new RegExp(pair!.find).test(src), "pair regex must self-validate against its source");
    assert.ok(finds.filter(f => f.type !== "pair").every(s => pair!.durability <= s.durability + 1), "pairs rank at or below singles");
});

check("R20: intl keys ending in a digit segment are not CSS-hash-penalized", () => {
    const d = scoreDurability("#{intl::TIP_DIRECT_MESSAGES_BODY3}");
    assert.strictEqual(d.tier, "intl");
    assert.strictEqual(d.score, 10);
});

check("R21: store names containing digits are recognized as storeName tier", () => {
    const d = scoreDurability('="UserAffinitiesV2Store"');
    assert.strictEqual(d.tier, "storeName");
    assert.ok(d.score >= 8);
});

check("R22: synthesized pair gaps use a newline-inclusive bounded class", () => {
    const src = '0,function(e,t,n){var a=n(1);return o("StableAnchorAlpha",ab.cd,"StableAnchorBeta")}';
    const pair = generateFinds(src, { synthesizePairs: true, minScore: 0, limit: 500 }).find(f => f.type === "pair");
    assert.ok(pair, "expected a pair");
    assert.ok(pair!.find.includes("[\\s\\S]{0,"), "gap must be newline-inclusive");
});

check("R23: a hash-bearing name ending in Store is not trusted as a durable store name", () => {
    const d = scoreDurability('"Modal7f3aStore"');
    assert.strictEqual(d.tier, "string");
    assert.strictEqual(d.score, 6);
});

check("R24: a legitimate digit-bearing store name is still storeName tier", () => {
    const d = scoreDurability('"OAuth2AuthorizeStore"');
    assert.strictEqual(d.tier, "storeName");
    assert.ok(d.score >= 8);
});

check("R25: a raw 6-char intl-hash find is still penalized for an embedded CSS hash", () => {
    const d = scoreDurability('className:"header_9f8e7",i.t.a8Bc0z');
    assert.strictEqual(d.tier, "intl");
    assert.ok(d.score <= 2, `expected <= 2, got ${d.score}`);
});

check("R26: a strong #{intl::KEY} placeholder stays exempt from volatility penalties", () => {
    const d = scoreDurability('#{intl::FOO}+className:"x_ab12cd"');
    assert.strictEqual(d.tier, "intl");
    assert.strictEqual(d.score, 10);
});

console.log(`\nall ${passed} checks passed`);
