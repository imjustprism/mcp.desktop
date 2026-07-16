/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const REF_PATTERN = /^\$(\d+)((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\.\d+)*)$/;
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

export function isRefString(s: string): boolean {
    return typeof s === "string" && REF_PATTERN.test(s);
}

function parsePath(path: string): readonly (string | number)[] {
    const segments: (string | number)[] = [];
    for (const m of path.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\.(\d+)/g)) {
        if (m[1] !== undefined) segments.push(m[1]);
        else segments.push(Number(m[2] ?? m[3]));
    }
    return segments;
}

function readOwn(container: unknown, key: string | number): unknown {
    if (container === null || typeof container !== "object") return undefined;
    if (Array.isArray(container)) {
        if (typeof key !== "number") return undefined;
        return key < container.length ? container[key] : undefined;
    }
    const name = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, name)) return undefined;
    return (container as Record<string, unknown>)[name];
}

function resolveRef(ref: string, priorResults: readonly unknown[]): unknown {
    const match = REF_PATTERN.exec(ref);
    if (match === null) return ref;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= priorResults.length) return null;
    let current: unknown = priorResults[index];
    for (const segment of parsePath(match[2])) {
        current = readOwn(current, segment);
        if (current === undefined) return null;
    }
    return current ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

interface WalkBudget {
    nodes: number;
}

function walk(value: unknown, priorResults: readonly unknown[], depth: number, budget: WalkBudget): unknown {
    budget.nodes++;
    if (budget.nodes > MAX_NODES) return value;
    if (typeof value === "string") return isRefString(value) ? resolveRef(value, priorResults) : value;
    if (depth >= MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map(item => walk(item, priorResults, depth + 1, budget));
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) out[key] = walk(value[key], priorResults, depth + 1, budget);
        return out;
    }
    return value;
}

export function resolveRefs<T>(value: T, priorResults: readonly unknown[]): T {
    return walk(value, priorResults, 0, { nodes: 0 }) as T;
}
