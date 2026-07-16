/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface TreeNode {
    readonly name: string;
    readonly key?: string | null;
    readonly props?: Readonly<Record<string, unknown>>;
    readonly children?: readonly TreeNode[];
}

export interface PropDelta {
    readonly prop: string;
    readonly before: unknown;
    readonly after: unknown;
}

export interface NodeChange {
    readonly path: string;
    readonly name: string;
    readonly propDeltas: readonly PropDelta[];
}

export interface TreeDiff {
    readonly added: readonly { readonly path: string; readonly name: string }[];
    readonly removed: readonly { readonly path: string; readonly name: string }[];
    readonly changed: readonly NodeChange[];
    readonly unchangedCount: number;
}

const MAX_NODES = 5000;
const MAX_DEPTH = 60;

interface Budget {
    remaining: number;
}

interface MutableDiff {
    added: { path: string; name: string }[];
    removed: { path: string; name: string }[];
    changed: NodeChange[];
    unchangedCount: number;
}

function identityOf(node: TreeNode): string {
    return node.name + "#" + (node.key ?? "");
}

function serializeValue(value: unknown): string {
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
    } catch { }
    try {
        return String(value);
    } catch {
        return "unserializable value";
    }
}

function childPath(parentPath: string, node: TreeNode, siblings: readonly TreeNode[], index: number): string {
    let total = 0;
    let occurrence = 0;
    for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].name === node.name) {
            total++;
            if (i < index) occurrence++;
        }
    }
    const label = total > 1 ? node.name + "[" + occurrence + "]" : node.name;
    return parentPath.length > 0 ? parentPath + "/" + label : label;
}

function diffProps(
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined
): PropDelta[] {
    const b = before ?? {};
    const a = after ?? {};
    const keys = new Set<string>();
    for (const key of Object.keys(b)) keys.add(key);
    for (const key of Object.keys(a)) keys.add(key);
    const deltas: PropDelta[] = [];
    for (const key of [...keys].sort()) {
        const inBefore = Object.prototype.hasOwnProperty.call(b, key);
        const inAfter = Object.prototype.hasOwnProperty.call(a, key);
        if (inBefore && inAfter) {
            if (serializeValue(b[key]) !== serializeValue(a[key])) {
                deltas.push({ prop: key, before: b[key], after: a[key] });
            }
        } else {
            deltas.push({
                prop: key,
                before: inBefore ? b[key] : undefined,
                after: inAfter ? a[key] : undefined
            });
        }
    }
    return deltas;
}

function collectSubtree(
    node: TreeNode,
    path: string,
    depth: number,
    budget: Budget,
    out: { path: string; name: string }[]
): void {
    if (budget.remaining <= 0 || depth > MAX_DEPTH) return;
    budget.remaining--;
    out.push({ path, name: node.name });
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
        if (budget.remaining <= 0) return;
        collectSubtree(children[i], childPath(path, children[i], children, i), depth + 1, budget, out);
    }
}

function diffChildren(
    beforeChildren: readonly TreeNode[],
    afterChildren: readonly TreeNode[],
    parentPath: string,
    depth: number,
    budget: Budget,
    diff: MutableDiff
): void {
    if (beforeChildren.length === 0 && afterChildren.length === 0) return;
    const afterByIdentity = new Map<string, number[]>();
    for (let i = 0; i < afterChildren.length; i++) {
        const id = identityOf(afterChildren[i]);
        const bucket = afterByIdentity.get(id);
        if (bucket !== undefined) bucket.push(i);
        else afterByIdentity.set(id, [i]);
    }
    const matchedAfterIndex: number[] = new Array(beforeChildren.length).fill(-1);
    const afterConsumed: boolean[] = new Array(afterChildren.length).fill(false);
    for (let i = 0; i < beforeChildren.length; i++) {
        const bucket = afterByIdentity.get(identityOf(beforeChildren[i]));
        if (bucket !== undefined && bucket.length > 0) {
            const j = bucket.shift()!;
            matchedAfterIndex[i] = j;
            afterConsumed[j] = true;
        }
    }
    for (let i = 0; i < beforeChildren.length; i++) {
        if (budget.remaining <= 0) return;
        const j = matchedAfterIndex[i];
        if (j === -1) {
            collectSubtree(
                beforeChildren[i],
                childPath(parentPath, beforeChildren[i], beforeChildren, i),
                depth,
                budget,
                diff.removed
            );
        } else {
            diffMatched(
                beforeChildren[i],
                afterChildren[j],
                childPath(parentPath, afterChildren[j], afterChildren, j),
                depth,
                budget,
                diff
            );
        }
    }
    for (let j = 0; j < afterChildren.length; j++) {
        if (budget.remaining <= 0) return;
        if (!afterConsumed[j]) {
            collectSubtree(
                afterChildren[j],
                childPath(parentPath, afterChildren[j], afterChildren, j),
                depth,
                budget,
                diff.added
            );
        }
    }
}

function diffMatched(
    before: TreeNode,
    after: TreeNode,
    path: string,
    depth: number,
    budget: Budget,
    diff: MutableDiff
): void {
    if (budget.remaining <= 0 || depth > MAX_DEPTH) return;
    budget.remaining--;
    const deltas = diffProps(before.props, after.props);
    if (deltas.length > 0) diff.changed.push({ path, name: after.name, propDeltas: deltas });
    else diff.unchangedCount++;
    diffChildren(before.children ?? [], after.children ?? [], path, depth + 1, budget, diff);
}

export function diffReactTrees(before: TreeNode | null, after: TreeNode | null): TreeDiff {
    const diff: MutableDiff = { added: [], removed: [], changed: [], unchangedCount: 0 };
    const budget: Budget = { remaining: MAX_NODES };
    if (before === null && after === null) {
        return diff;
    }
    if (before === null) {
        collectSubtree(after!, after!.name, 0, budget, diff.added);
        return diff;
    }
    if (after === null) {
        collectSubtree(before, before.name, 0, budget, diff.removed);
        return diff;
    }
    if (identityOf(before) === identityOf(after)) {
        diffMatched(before, after, after.name, 0, budget, diff);
    } else {
        collectSubtree(before, before.name, 0, budget, diff.removed);
        collectSubtree(after, after.name, 0, budget, diff.added);
    }
    return diff;
}
