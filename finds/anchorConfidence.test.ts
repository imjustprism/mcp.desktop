/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { AnchorSignals, scoreAnchorConfidence } from "./anchorConfidence";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function signals(overrides: Partial<AnchorSignals>): AnchorSignals {
    return {
        durability: 6,
        moduleCount: 1,
        type: "sequence",
        regex: false,
        ...overrides
    };
}

check("a unique tier 10 intl find scores high band", () => {
    const r = scoreAnchorConfidence(signals({ durability: 10, type: "intl" }));
    assert.strictEqual(r.band, "high");
    assert.ok(r.confidence >= 75, `confidence ${r.confidence} should clear the high floor`);
    assert.ok(r.reasons.includes("unique among loaded modules"));
    assert.ok(r.reasons.includes("durable intl key anchor"));
});

check("strong margin beats whole-only margin with all else equal", () => {
    const strong = scoreAnchorConfidence(signals({ marginStrength: "strong", minFragmentMatches: 1 }));
    const wholeOnly = scoreAnchorConfidence(signals({ marginStrength: "whole-only", minFragmentMatches: 30 }));
    const neutral = scoreAnchorConfidence(signals({}));
    assert.ok(strong.confidence > wholeOnly.confidence, `${strong.confidence} should beat ${wholeOnly.confidence}`);
    assert.ok(strong.confidence > neutral.confidence, "strong margin should add over no margin");
    assert.ok(wholeOnly.confidence < neutral.confidence, "whole-only margin should subtract");
    assert.ok(wholeOnly.reasons.includes("unique only as a whole string"));
});

check("moduleCount 0 clamps very low regardless of durability", () => {
    const r = scoreAnchorConfidence(signals({ durability: 10, type: "intl", moduleCount: 0, marginStrength: "strong" }));
    assert.ok(r.confidence <= 5, `confidence ${r.confidence} should be clamped very low`);
    assert.strictEqual(r.band, "low");
    assert.ok(r.reasons.some(x => x.includes("broken")));
});

check("a find matching many modules lands low band", () => {
    const r = scoreAnchorConfidence(signals({ durability: 8, moduleCount: 40 }));
    assert.strictEqual(r.band, "low");
    assert.ok(r.reasons.includes("matches 40 modules so not a usable anchor"));
});

check("penalty grows with the module count", () => {
    const two = scoreAnchorConfidence(signals({ moduleCount: 2 }));
    const five = scoreAnchorConfidence(signals({ moduleCount: 5 }));
    const forty = scoreAnchorConfidence(signals({ moduleCount: 40 }));
    const unique = scoreAnchorConfidence(signals({ moduleCount: 1 }));
    assert.ok(unique.confidence > two.confidence);
    assert.ok(two.confidence > five.confidence);
    assert.ok(five.confidence >= forty.confidence);
});

check("a unique token find gets a resilience mention in reasons", () => {
    const r = scoreAnchorConfidence(signals({ durability: 7, type: "token", regex: true }));
    assert.ok(r.reasons.includes("resilient to identifier renames"));
    assert.ok(r.reasons.includes("unique among loaded modules"));
});

check("confidence is always an integer in 0..100 across a sweep", () => {
    const types: AnchorSignals["type"][] = ["intl", "sequence", "token", "pair"];
    const margins: (AnchorSignals["marginStrength"] | undefined)[] = [undefined, "strong", "moderate", "whole-only"];
    for (let durability = 0; durability <= 10; durability++) {
        for (const moduleCount of [0, 1, 2, 3, 8, 40, 500]) {
            for (const type of types) {
                for (const margin of margins) {
                    for (const regex of [false, true]) {
                        const r = scoreAnchorConfidence({ durability, moduleCount, type, regex, marginStrength: margin, minFragmentMatches: null });
                        assert.ok(Number.isInteger(r.confidence), `not an integer: ${r.confidence}`);
                        assert.ok(r.confidence >= 0 && r.confidence <= 100, `out of range: ${r.confidence}`);
                        assert.ok(r.reasons.length >= 2 && r.reasons.length <= 4, `reason count ${r.reasons.length}`);
                    }
                }
            }
        }
    }
});

check("raising durability with all else equal never lowers confidence", () => {
    const types: AnchorSignals["type"][] = ["intl", "sequence", "token", "pair"];
    const margins: (AnchorSignals["marginStrength"] | undefined)[] = [undefined, "strong", "moderate", "whole-only"];
    for (const moduleCount of [0, 1, 2, 12]) {
        for (const type of types) {
            for (const margin of margins) {
                let prev = -1;
                for (let durability = 0; durability <= 10; durability++) {
                    const r = scoreAnchorConfidence({ durability, moduleCount, type, regex: false, marginStrength: margin });
                    assert.ok(r.confidence >= prev, `durability ${durability} dropped confidence ${prev} to ${r.confidence}`);
                    prev = r.confidence;
                }
            }
        }
    }
});

check("bands follow the documented thresholds", () => {
    for (const s of [
        signals({ durability: 10, type: "intl" }),
        signals({ durability: 3, moduleCount: 9 }),
        signals({ durability: 6 })
    ]) {
        const r = scoreAnchorConfidence(s);
        if (r.confidence >= 75) assert.strictEqual(r.band, "high");
        else if (r.confidence >= 45) assert.strictEqual(r.band, "medium");
        else assert.strictEqual(r.band, "low");
    }
});

check("reasons contain no semicolons and no dashes", () => {
    const samples = [
        signals({ durability: 10, type: "intl" }),
        signals({ durability: 2, type: "pair", moduleCount: 40, marginStrength: "whole-only" }),
        signals({ durability: 7, type: "token", regex: true, marginStrength: "strong" }),
        signals({ moduleCount: 0 })
    ];
    for (const s of samples) {
        for (const reason of scoreAnchorConfidence(s).reasons) {
            assert.ok(!reason.includes(";"), reason);
            assert.ok(!/[-–—]/.test(reason), reason);
        }
    }
});

check("scoring is deterministic", () => {
    const s = signals({ durability: 7, type: "token", regex: true, marginStrength: "strong", minFragmentMatches: 1 });
    assert.deepStrictEqual(scoreAnchorConfidence(s), scoreAnchorConfidence(s));
});

console.log(`\nall ${passed} checks passed`);
