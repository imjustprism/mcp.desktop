/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface StackFrame {
    readonly raw: string;
    readonly fn: string | null;
    readonly moduleId: string | null;
    readonly patchedBy: readonly string[] | null;
}

export interface StackAttribution {
    readonly frames: readonly StackFrame[];
    readonly topModuleId: string | null;
    readonly modulesInvolved: readonly string[];
}

const MODULE_TOKEN = /WebpackModule(\d+)/;
const LOCATION_TAIL = /\S+:\d+(?::\d+)?\)?$/;

export function attributeStack(
    stack: string,
    patchedByResolver?: (moduleId: string) => readonly string[] | null | undefined
): StackAttribution {
    const frames: StackFrame[] = [];
    const modulesInvolved: string[] = [];
    const seen = new Set<string>();
    let topModuleId: string | null = null;

    if (typeof stack !== "string" || stack.length === 0) {
        return { frames, topModuleId, modulesInvolved };
    }

    for (const line of stack.split(/\r\n|\r|\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        const startsWithAt = trimmed.startsWith("at ");
        if (!startsWithAt && !LOCATION_TAIL.test(trimmed)) continue;

        const moduleId = MODULE_TOKEN.exec(trimmed)?.[1] ?? null;

        let fn: string | null = null;
        if (startsWithAt) {
            const rest = trimmed.slice(3).trim();
            const parenIndex = rest.indexOf("(");
            if (parenIndex > 0) {
                const name = rest.slice(0, parenIndex).trim();
                if (name.length > 0 && !LOCATION_TAIL.test(name)) fn = name;
            }
        }

        let patchedBy: readonly string[] | null = null;
        if (moduleId !== null && typeof patchedByResolver === "function") {
            try {
                patchedBy = patchedByResolver(moduleId) ?? null;
            } catch {
                patchedBy = null;
            }
        }

        frames.push({ raw: trimmed, fn, moduleId, patchedBy });

        if (moduleId !== null) {
            if (topModuleId === null) topModuleId = moduleId;
            if (!seen.has(moduleId)) {
                seen.add(moduleId);
                modulesInvolved.push(moduleId);
            }
        }
    }

    return { frames, topModuleId, modulesInvolved };
}
