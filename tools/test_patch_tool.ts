/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";
import { wreq } from "@webpack";

import { countModuleMatchesFast, getIntlKeyFromHash, getModuleSource, parseRegex } from "./utils";

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
    let targetModuleId: string | null = null;

    for (const id of Object.keys(wreq.m)) {
        if (moduleMatches.length > 5) break;

        const source = getModuleSource(id);
        const matchIdx = findRegex ? source.search(findRegex) : source.indexOf(findStr as string);

        if (matchIdx !== -1) {
            const start = Math.max(0, matchIdx - 40);
            const end = Math.min(source.length, matchIdx + 120);
            moduleMatches.push({ id, snippet: source.slice(start, end) });
            if (!targetModule) {
                targetModule = source;
                targetModuleId = id;
            }
        }
    }

    const findUnique = moduleMatches.length === 1;
    let matchWorks = false;
    let matchedText: string | null = null;
    let captureGroups = 0;
    let replacementPreview: string | null = null;
    let matchIndex: number | null = null;
    let canonicalizedRegex: string | null = null;
    let matchContext: string | null = null;

    if (targetModule) {
        let regex: RegExp;
        try {
            const matchRegex = parseRegex(matchPattern);
            regex = canonicalizeMatch(matchRegex ?? new RegExp(matchPattern));
        } catch {
            return { error: true, message: `Invalid match regex: ${matchPattern}` };
        }

        const regexStr = `/${regex.source}/${regex.flags}`;
        canonicalizedRegex = regexStr !== matchPattern ? regexStr : null;

        const match = targetModule.match(regex);

        matchWorks = !!match;
        matchedText = match?.[0]?.slice(0, 300) ?? null;
        captureGroups = match ? match.length - 1 : 0;
        matchIndex = match?.index ?? null;

        if (matchWorks && matchIndex !== null) {
            const ctxStart = Math.max(0, matchIndex - 80);
            const ctxEnd = Math.min(targetModule.length, matchIndex + (match![0].length) + 80);
            matchContext = targetModule.slice(ctxStart, ctxEnd);
        }

        if (matchWorks && replaceStr && matchIndex !== null) {
            const replaced = targetModule.replace(regex, replaceStr);
            const start = Math.max(0, matchIndex - 50);
            const end = Math.min(replaced.length, matchIndex + replaceStr.length + 200);
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

    let findContext: string | undefined;
    if (findUnique && !matchWorks && targetModule) {
        const canonFind = findStr as string;
        const idx = findRegex ? targetModule.search(findRegex) : targetModule.indexOf(canonFind);
        if (idx !== -1) {
            const start = Math.max(0, idx - 300);
            const end = Math.min(targetModule.length, idx + 500);
            findContext = targetModule.slice(start, end);
        }
    }

    let nearbyAnchors: Array<{ anchor: string; type: string; unique: boolean; distance: number }> | undefined;
    if (findUnique && targetModule) {
        const canonFind = findStr as string;
        const findIdx = findRegex ? targetModule.search(findRegex) : targetModule.indexOf(canonFind);
        if (findIdx !== -1) {
            nearbyAnchors = discoverAnchors(targetModule, findIdx, 500);
        }
    }

    return {
        find: rawFind,
        findCanonicalized: findStr !== rawFind ? findStr : undefined,
        match: matchPattern,
        matchCanonicalized: canonicalizedRegex,
        replace: replaceStr ?? null,
        moduleId: findUnique ? targetModuleId : undefined,
        findUnique,
        findModuleCount: moduleMatches.length,
        findModules: moduleMatches.slice(0, 5),
        matchWorks,
        matchedText,
        matchContext,
        captureGroups,
        replacementPreview,
        findContext,
        nearbyAnchors: nearbyAnchors?.length ? nearbyAnchors : undefined,
        verdict
    };
}

function discoverAnchors(source: string, centerIdx: number, radius: number): Array<{ anchor: string; type: string; unique: boolean; distance: number }> {
    const start = Math.max(0, centerIdx - radius);
    const end = Math.min(source.length, centerIdx + radius);
    const region = source.slice(start, end);
    const anchors: Array<{ anchor: string; type: string; unique: boolean; distance: number }> = [];
    const seen = new Set<string>();

    const add = (raw: string, display: string, type: string, regionIdx: number) => {
        if (seen.has(display) || display.length < 6) return;
        seen.add(display);
        const absIdx = start + regionIdx;
        const distance = Math.abs(absIdx - centerIdx);
        const unique = countModuleMatchesFast(raw, 3) === 1;
        anchors.push({ anchor: display, type, unique, distance });
    };

    const intlDot = /\.t\.([A-Za-z0-9+/]{6})/g;
    const intlBracket = /\.t\["([A-Za-z0-9+/]{6,8})"\]/g;
    for (const regex of [intlDot, intlBracket]) {
        let m;
        while ((m = regex.exec(region))) {
            const hash = m[1];
            const key = getIntlKeyFromHash(hash);
            const display = key ? `#{intl::${key}}` : `#{intl::${hash}::raw}`;
            add(`.${hash}`, display, "intl", m.index);
        }
    }

    const strLit = /"([^"\\]{8,50})"/g;
    let m;
    while ((m = strLit.exec(region))) {
        add(m[1], `"${m[1]}"`, "string", m.index);
    }

    const funcCall = /([a-zA-Z_$][\w$]{4,25})\s*\(/g;
    while ((m = funcCall.exec(region))) {
        const name = m[1];
        if (!/^(function|return|const|if|for|while|else|switch|case|break|continue|typeof|instanceof|void|delete|new|throw|try|catch|finally|class|extends|super|import|export|default|let|var|this|null|undefined|true|false)$/.test(name)) {
            add(`${name}(`, `${name}(`, "funcCall", m.index);
        }
    }

    const propAssign = /([a-zA-Z_$][\w$]{3,25}):\s*(?!\s*function)/g;
    while ((m = propAssign.exec(region))) {
        add(`${m[1]}:`, `${m[1]}:`, "prop", m.index);
    }

    anchors.sort((a, b) => {
        if (a.unique !== b.unique) return a.unique ? -1 : 1;
        const typeOrder: Record<string, number> = { intl: 0, string: 1, funcCall: 2, prop: 3 };
        const typeA = typeOrder[a.type] ?? 4;
        const typeB = typeOrder[b.type] ?? 4;
        if (typeA !== typeB) return typeA - typeB;
        return a.distance - b.distance;
    });

    return anchors.slice(0, 12);
}
