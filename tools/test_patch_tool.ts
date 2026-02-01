/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";
import { wreq } from "@webpack";

import { getModuleSource, parseRegex } from "./utils";

export async function handleTestPatchTool(args: Record<string, unknown>): Promise<unknown> {
    const rawFind = args.find as string | undefined;
    const matchPattern = args.match as string | undefined;
    const replaceStr = args.replace as string | undefined;

    if (!rawFind || rawFind.length < 3) return { error: true, message: "find required and must be at least 3 characters" };
    if (!matchPattern) return { error: true, message: "match required" };

    const findStr = canonicalizeMatch(rawFind);
    const findRegex = typeof findStr === "string" && findStr.startsWith("(?:") ? new RegExp(findStr) : null;
    const moduleMatches: Array<{ id: string; snippet: string }> = [];
    let targetModule: string | null = null;

    for (const id of Object.keys(wreq.m)) {
        if (moduleMatches.length > 5) break;

        const source = getModuleSource(id);
        const matchIdx = findRegex ? source.search(findRegex) : source.indexOf(findStr as string);

        if (matchIdx !== -1) {
            const start = Math.max(0, matchIdx - 40);
            const end = Math.min(source.length, matchIdx + 120);
            moduleMatches.push({ id, snippet: source.slice(start, end) });
            if (!targetModule) targetModule = source;
        }
    }

    const findUnique = moduleMatches.length === 1;
    let matchWorks = false;
    let matchedText: string | null = null;
    let captureGroups = 0;
    let replacementPreview: string | null = null;
    let matchIndex: number | null = null;

    if (targetModule) {
        const matchRegex = parseRegex(matchPattern);
        const regex = matchRegex ? canonicalizeMatch(matchRegex) : canonicalizeMatch(new RegExp(matchPattern));
        const match = targetModule.match(regex);

        matchWorks = !!match;
        matchedText = match?.[0]?.slice(0, 200) ?? null;
        captureGroups = match ? match.length - 1 : 0;
        matchIndex = match?.index ?? null;

        if (matchWorks && replaceStr && matchIndex !== null) {
            const replaced = targetModule.replace(regex, replaceStr);
            const start = Math.max(0, matchIndex - 50);
            const end = Math.min(replaced.length, matchIndex + replaceStr.length + 150);
            replacementPreview = replaced.slice(start, end);
        }
    }

    let verdict: string;
    if (!findUnique) {
        verdict = moduleMatches.length === 0 ? "FAIL: find string matches no modules" : "FAIL: find string matches multiple modules";
    } else if (!matchWorks) {
        verdict = "FAIL: match pattern doesn't match module";
    } else if (captureGroups > 4) {
        verdict = "WARN: Too many capture groups (5+)";
    } else {
        verdict = "PASS: Patch looks valid";
    }

    return {
        find: rawFind,
        findCanonicalized: findStr,
        match: matchPattern,
        replace: replaceStr ?? null,
        findUnique,
        findModuleCount: moduleMatches.length,
        findModules: moduleMatches.slice(0, 5),
        matchWorks,
        matchedText,
        captureGroups,
        replacementPreview,
        verdict
    };
}
