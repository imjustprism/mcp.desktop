/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { generateFinds } from "../finds/genFinds";
import { ModuleToolArgs, ToolResult } from "../types";
import * as u from "./utils";

export function handleGenFinds(args: ModuleToolArgs): ToolResult {
    const { id } = args;
    if (!id) return u.missingArg("id");

    const source = u.getModuleSource(id);
    if (!source) return u.moduleNotFound(id);

    const minScore = u.clamp(args.minScore, 8, 1, 1000);
    const limit = u.clamp(args.limit, 20, 1, 200);

    const candidates = generateFinds(source, {
        hashToKey: hash => u.getIntlKeyFromHash(hash),
        minScore,
        limit: Math.max(limit, 100)
    });

    const canonByFind = new Map<string, string>();
    for (const c of candidates) canonByFind.set(c.find, canonicalizeMatch(c.find));
    const counts = u.batchCountModuleMatches([...new Set(canonByFind.values())], 10);

    let finds = candidates.map(c => {
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

    if (!finds.some(f => f.unique)) {
        for (const c of generateFinds(source, { hashToKey: hash => u.getIntlKeyFromHash(hash), minScore, limit: 500, synthesizePairs: true })) {
            if (c.type !== "pair") continue;
            let re: RegExp;
            try { re = new RegExp(c.find); } catch { continue; }
            const count = u.findModuleIds(src => re.test(src), 10).length;
            finds.push({ find: c.find, type: c.type, tier: c.tier, score: c.score, durability: c.durability, unique: count === 1, moduleCount: count, reason: c.reasons[0], regex: true });
        }
    }

    if (args.requireUnique) finds = finds.filter(f => f.unique);
    finds.sort((a, b) => Number(b.unique) - Number(a.unique) || b.durability - a.durability || b.score - a.score);

    return {
        id,
        sourceSize: source.length,
        candidateCount: candidates.length,
        uniqueCount: finds.filter(f => f.unique).length,
        uniquenessScope: "loaded-factories",
        note: "Ranked by unique, then durability (build-stability, 0-10), then score. `score` is raw sequence weight (longer/denser = higher) and is NOT a quality measure — a high-score find can be a fragile one. Pick by `unique` + `durability`/`tier`. `uniquenessScope` is loaded factories only; a unique find can still collide with a lazy chunk (module.loadLazy first for lazy-heavy surfaces).",
        finds: finds.slice(0, limit)
    };
}
