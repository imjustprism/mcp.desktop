/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface SymbolUse {
    readonly prop: string;
    readonly count: number;
}

const IDENT = "[A-Za-z_$][\\w$]*";
const NOT_MID_IDENT = "(?<![\\w$.])";
const MAX_SYMBOLS = 50;

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNoiseProp(prop: string): boolean {
    return prop.length === 0 || /^[$_]*\d+$/.test(prop);
}

export function findRequireBindings(importerSource: string, requireParam: string, targetModuleId: string): string[] {
    const req = escapeRegex(requireParam);
    const id = escapeRegex(targetModuleId);
    const found = new Set<string>();

    const direct = new RegExp(`${NOT_MID_IDENT}(${IDENT})\\s*=\\s*${req}\\s*\\(\\s*${id}\\s*\\)`, "g");
    for (const m of importerSource.matchAll(direct)) found.add(m[1]);

    const interopInline = new RegExp(
        `${NOT_MID_IDENT}(${IDENT})\\s*=\\s*${req}\\s*\\.\\s*n\\s*\\(\\s*(${IDENT})\\s*=\\s*${req}\\s*\\(\\s*${id}\\s*\\)\\s*\\)`,
        "g"
    );
    for (const m of importerSource.matchAll(interopInline)) {
        found.add(m[1]);
        found.add(m[2]);
    }

    const interopWrap = new RegExp(`${NOT_MID_IDENT}(${IDENT})\\s*=\\s*${req}\\s*\\.\\s*n\\s*\\(\\s*(${IDENT})\\s*\\)`, "g");
    let grew = true;
    while (grew) {
        grew = false;
        for (const m of importerSource.matchAll(interopWrap)) {
            if (found.has(m[2]) && !found.has(m[1])) {
                found.add(m[1]);
                grew = true;
            }
        }
    }

    return [...found];
}

export function extractSymbolUsage(importerSource: string, bindings: readonly string[]): SymbolUse[] {
    const counts = new Map<string, number>();
    for (const binding of new Set(bindings)) {
        const access = new RegExp(`${NOT_MID_IDENT}${escapeRegex(binding)}\\s*\\.\\s*(${IDENT})`, "g");
        for (const m of importerSource.matchAll(access)) {
            counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
        }
    }

    const uses: SymbolUse[] = [];
    for (const [prop, count] of counts) {
        if (!isNoiseProp(prop)) uses.push({ prop, count });
    }
    uses.sort((a, b) => b.count - a.count || (a.prop < b.prop ? -1 : a.prop > b.prop ? 1 : 0));
    return uses.slice(0, MAX_SYMBOLS);
}
