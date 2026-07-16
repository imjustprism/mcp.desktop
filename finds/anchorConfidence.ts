/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface AnchorSignals {
    readonly durability: number;
    readonly moduleCount: number;
    readonly type: "intl" | "sequence" | "token" | "pair";
    readonly regex: boolean;
    readonly marginStrength?: "strong" | "moderate" | "whole-only";
    readonly minFragmentMatches?: number | null;
}

export interface AnchorConfidence {
    readonly confidence: number;
    readonly band: "high" | "medium" | "low";
    readonly reasons: readonly string[];
}

const DURABILITY_SCALE = 5.5;
const UNIQUE_BONUS = 30;
const NON_UNIQUE_PENALTY_PER_EXTRA = 6;
const NON_UNIQUE_PENALTY_CAP = 45;
const BROKEN_CEILING = 5;
const MARGIN_STRONG_BONUS = 8;
const MARGIN_WHOLE_ONLY_PENALTY = 8;
const TYPE_INTL_BONUS = 6;
const TYPE_TOKEN_BONUS = 4;
const TYPE_PAIR_PENALTY = 3;
const REGEX_BONUS = 2;
const HIGH_FLOOR = 75;
const MEDIUM_FLOOR = 45;
const DURABLE_FLOOR = 8;
const MODERATE_FLOOR = 5;

function clampDurability(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, n));
}

function bandOf(confidence: number): "high" | "medium" | "low" {
    if (confidence >= HIGH_FLOOR) return "high";
    if (confidence >= MEDIUM_FLOOR) return "medium";
    return "low";
}

function uniquenessReason(moduleCount: number): string {
    if (moduleCount === 0) return "does not match its own module so the find is broken";
    if (moduleCount === 1) return "unique among loaded modules";
    return `matches ${moduleCount} modules so not a usable anchor`;
}

function durabilityReason(durability: number, type: AnchorSignals["type"]): string {
    if (durability >= DURABLE_FLOOR) {
        return type === "intl" ? "durable intl key anchor" : "strong build durability";
    }
    if (durability >= MODERATE_FLOOR) return "moderate build durability";
    return "weak build durability so likely to drift";
}

function typeReason(type: AnchorSignals["type"]): string | null {
    if (type === "token") return "resilient to identifier renames";
    if (type === "pair") return "pair anchors are slightly less preferred";
    return null;
}

function marginReason(marginStrength: AnchorSignals["marginStrength"]): string | null {
    if (marginStrength === "strong") return "a fragment alone is already unique";
    if (marginStrength === "whole-only") return "unique only as a whole string";
    return null;
}

export function scoreAnchorConfidence(s: AnchorSignals): AnchorConfidence {
    const durability = clampDurability(s.durability);
    const moduleCount = Number.isFinite(s.moduleCount) ? Math.max(0, Math.floor(s.moduleCount)) : 0;
    let raw = durability * DURABILITY_SCALE;

    if (moduleCount === 1) {
        raw += UNIQUE_BONUS;
    } else if (moduleCount > 1) {
        raw -= Math.min(NON_UNIQUE_PENALTY_CAP, NON_UNIQUE_PENALTY_PER_EXTRA * (moduleCount - 1));
    }

    if (s.marginStrength === "strong") raw += MARGIN_STRONG_BONUS;
    else if (s.marginStrength === "whole-only") raw -= MARGIN_WHOLE_ONLY_PENALTY;

    if (s.type === "intl") raw += TYPE_INTL_BONUS;
    else if (s.type === "token") raw += TYPE_TOKEN_BONUS;
    else if (s.type === "pair") raw -= TYPE_PAIR_PENALTY;

    if (s.regex) raw += REGEX_BONUS;

    if (moduleCount === 0) raw = Math.min(raw, BROKEN_CEILING);

    const confidence = Math.round(Math.max(0, Math.min(100, raw)));

    const reasons: string[] = [
        uniquenessReason(moduleCount),
        durabilityReason(durability, s.type)
    ];
    const typeNote = typeReason(s.type);
    if (typeNote) reasons.push(typeNote);
    const marginNote = marginReason(s.marginStrength);
    if (marginNote) reasons.push(marginNote);

    return { confidence, band: bandOf(confidence), reasons };
}
