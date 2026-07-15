import assert from "node:assert";

import { generateKeyCandidates, recoverIntlKey } from "./intlRecover";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function stubHash(k: string): string {
    let h = 2166136261;
    for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    let n = h >>> 0;
    for (let i = 0; i < 6; i++) { out += alpha[n % 64]; n = Math.floor(n / 64) + i * 7 + 13; }
    return out;
}

check("derives SCREAMING_SNAKE bases and common affix variants", () => {
    const c = generateKeyCandidates("Remove attachment");
    assert.ok(c.includes("REMOVE_ATTACHMENT"), "base");
    assert.ok(c.includes("REMOVE_ATTACHMENT_TOOLTIP_TEXT"), "suffix variant");
    assert.ok(c.includes("A11Y_REMOVE_ATTACHMENT"), "prefix variant");
});

check("strips ICU placeholders and markdown", () => {
    const c = generateKeyCandidates("Send **{count}** messages to !!{user}!!");
    assert.ok(c.includes("SEND_MESSAGES"), c.slice(0, 5).join(", "));
    assert.ok(!c.some(k => k.includes("COUNT") || k.includes("USER")), "placeholder tokens must be dropped");
});

check("recovers the exact key by hash validation", () => {
    const key = "REMOVE_ATTACHMENT_TOOLTIP_TEXT";
    const hash = stubHash(key);
    assert.strictEqual(recoverIntlKey(hash, "Remove attachment", stubHash), key);
});

check("word-prefix truncation recovers a shorter key", () => {
    const key = "USER_PROFILE";
    assert.strictEqual(recoverIntlKey(stubHash(key), "User profile settings panel", stubHash), key);
});

check("returns null when no candidate hashes to the target", () => {
    assert.strictEqual(recoverIntlKey(stubHash("SOMETHING_UNRELATED_ENTIRELY"), "Remove attachment", stubHash), null);
});

check("candidate count is capped and empty input yields nothing", () => {
    assert.deepStrictEqual(generateKeyCandidates(""), []);
    const many = generateKeyCandidates(Array.from({ length: 60 }, (_, i) => `word${i}`).join(" "));
    assert.ok(many.length <= 300, `expected <= 300, got ${many.length}`);
});

check("recovers compound MODAL/affix keys (broadened coverage)", () => {
    const cases: Array<[string, string]> = [
        ["DELETE_MESSAGE_MODAL_HEADER", "Delete message"],
        ["LEAVE_SERVER_MODAL_BODY", "Leave server"],
        ["UNREADS_TAB_LABEL", "Unreads"]
    ];
    for (const [key, msg] of cases) assert.strictEqual(recoverIntlKey(stubHash(key), msg, stubHash), key, `should recover ${key}`);
});

check("recovers apostrophe/contraction keys (Discord drops the apostrophe)", () => {
    const cases: Array<[string, string]> = [["DONT_ASK_AGAIN", "Don't ask again"], ["LETS_GO", "Let's go!"]];
    for (const [key, msg] of cases) assert.strictEqual(recoverIntlKey(stubHash(key), msg, stubHash), key, `should recover ${key}`);
});

console.log(`\nall ${passed} checks passed`);
