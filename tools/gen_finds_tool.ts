/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { type AnchorSignals, scoreAnchorConfidence } from "../finds/anchorConfidence";
import { generateFinds } from "../finds/genFinds";
import { expandIi, generateTokenFinds } from "../finds/tokenFinds";
import { analyzeUniquenessMargin } from "../finds/uniquenessMargin";
import { ModuleToolArgs, ToolResult } from "../types";
import * as u from "./utils";

const MAX_TOKEN_ANCHORS = 12;
const MARGIN_BUDGET = 6;

export function handleGenFinds(args: ModuleToolArgs): ToolResult {
    const { id } = args;
    if (!id) return u.missingArg("id");

    const source = u.getModuleSource(id);
    if (!source) return u.moduleNotFound(id);

    const minScore = u.clamp(args.minScore, 6, 1, 1000);
    const limit = u.clamp(args.limit, 20, 1, 100);

    const candidates = generateFinds(source, {
        hashToKey: hash => u.getIntlKeyFromHash(hash),
        minScore,
        limit: Math.max(limit, 100)
    });

    const canonByFind = new Map<string, string>();
    for (const c of candidates) canonByFind.set(c.find, canonicalizeMatch(c.find));
    const counts = u.batchCountModuleMatches([...new Set(canonByFind.values())], 10);

    const seen = new Set<string>();
    let finds = candidates.map(c => {
        seen.add(c.find);
        const count = counts.get(canonByFind.get(c.find) ?? c.find)?.count ?? 0;
        return {
            find: c.find,
            type: c.type as string,
            tier: c.tier,
            score: c.score,
            durability: c.durability,
            unique: count === 1,
            moduleCount: count,
            reason: c.reasons[0],
            regex: false
        };
    });

    for (const tc of generateTokenFinds(source, { limit: MAX_TOKEN_ANCHORS })) {
        if (seen.has(tc.find)) continue;
        seen.add(tc.find);
        let re: RegExp;
        try { re = new RegExp(expandIi(tc.find)); } catch { continue; }
        const count = u.findModuleIds(src => re.test(src), 10).length;
        finds.push({ find: tc.find, type: "token", tier: tc.tier, score: tc.score, durability: tc.durability, unique: count === 1, moduleCount: count, reason: tc.reasons[0], regex: true });
    }

    if (!finds.some(f => f.unique)) {
        for (const c of generateFinds(source, { hashToKey: hash => u.getIntlKeyFromHash(hash), minScore, limit: 500, synthesizePairs: true })) {
            if (c.type !== "pair" || seen.has(c.find)) continue;
            seen.add(c.find);
            let re: RegExp;
            try { re = new RegExp(c.find); } catch { continue; }
            const count = u.findModuleIds(src => re.test(src), 10).length;
            finds.push({ find: c.find, type: c.type, tier: c.tier, score: c.score, durability: c.durability, unique: count === 1, moduleCount: count, reason: c.reasons[0], regex: true });
        }
    }

    if (args.requireUnique) finds = finds.filter(f => f.unique);

    const ranked = finds.map(f => ({
        f,
        baseConfidence: scoreAnchorConfidence({ durability: f.durability, moduleCount: f.moduleCount, type: f.type as AnchorSignals["type"], regex: f.regex }).confidence,
    }));
    ranked.sort((a, b) => b.baseConfidence - a.baseConfidence || b.f.durability - a.f.durability || b.f.score - a.f.score);

    let marginBudget = MARGIN_BUDGET;
    const out = ranked.slice(0, limit).map(({ f }) => {
        let margin;
        if (f.unique && marginBudget > 0 && f.type !== "intl") {
            marginBudget--;
            margin = analyzeUniquenessMargin(f.find, f.regex, frag => u.countModuleMatches(frag, 12));
        }
        const conf = scoreAnchorConfidence({
            durability: f.durability,
            moduleCount: f.moduleCount,
            type: f.type as AnchorSignals["type"],
            regex: f.regex,
            marginStrength: margin?.strength,
            minFragmentMatches: margin?.minFragmentMatches,
        });
        return { ...f, ...(margin ? { margin } : {}), confidence: conf.confidence, band: conf.band, confidenceReasons: conf.reasons };
    });
    out.sort((a, b) => b.confidence - a.confidence);

    return {
        id,
        sourceSize: source.length,
        candidateCount: candidates.length,
        uniqueCount: finds.filter(f => f.unique).length,
        uniquenessScope: "loaded-factories",
        note: "Ranked by confidence (0-100), which folds durability, uniqueness, margin, and type into one honest key, so just take the top finds. band is high, medium, or low. type token = a regex anchor with minified identifiers abstracted to the \\i metaclass, resilient to per-build renames. margin on the top unique finds shows how fragile the uniqueness is, where strong means a single fragment is already unique on its own. durability is the build-stability prior (0-10), score is how much stable content the find carries (a tiebreak, not quality). uniquenessScope is loaded factories only. A unique find can still collide with a lazy chunk, so module.loadLazy first for lazy-heavy surfaces.",
        finds: out
    };
}
