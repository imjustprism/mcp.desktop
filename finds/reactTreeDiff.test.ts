/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert";

import { diffReactTrees, TreeNode } from "./reactTreeDiff";

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

function node(name: string, extra?: Partial<TreeNode>): TreeNode {
    return { name, ...extra };
}

check("added leaf appears in added with a correct path", () => {
    const before = node("App", { children: [node("Shell", { children: [node("Chat")] })] });
    const after = node("App", { children: [node("Shell", { children: [node("Chat"), node("Toast")] })] });
    const d = diffReactTrees(before, after);
    assert.deepStrictEqual(d.added, [{ path: "App/Shell/Toast", name: "Toast" }]);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.changed.length, 0);
    assert.strictEqual(d.unchangedCount, 3);
});

check("removed subtree appears in removed with every node listed", () => {
    const before = node("App", { children: [node("Chat"), node("Panel", { children: [node("Button")] })] });
    const after = node("App", { children: [node("Chat")] });
    const d = diffReactTrees(before, after);
    assert.deepStrictEqual(d.removed, [
        { path: "App/Panel", name: "Panel" },
        { path: "App/Panel/Button", name: "Button" }
    ]);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.unchangedCount, 2);
});

check("prop change yields a PropDelta with before and after", () => {
    const before = node("App", { children: [node("Message", { props: { content: "hi", id: 1 } })] });
    const after = node("App", { children: [node("Message", { props: { content: "bye", id: 1 } })] });
    const d = diffReactTrees(before, after);
    assert.strictEqual(d.changed.length, 1);
    assert.strictEqual(d.changed[0].path, "App/Message");
    assert.strictEqual(d.changed[0].name, "Message");
    assert.deepStrictEqual(d.changed[0].propDeltas, [{ prop: "content", before: "hi", after: "bye" }]);
    assert.strictEqual(d.unchangedCount, 1);
});

check("prop present in only one side yields a delta with undefined on the other", () => {
    const before = node("Box", { props: { alpha: 1 } });
    const after = node("Box", { props: { alpha: 1, beta: true } });
    const d = diffReactTrees(before, after);
    assert.deepStrictEqual(d.changed[0].propDeltas, [{ prop: "beta", before: undefined, after: true }]);
});

check("reordering with keys still matches by key with no false add or remove", () => {
    const before = node("List", {
        children: [
            node("Row", { key: "a", props: { label: "first" } }),
            node("Row", { key: "b", props: { label: "second" } }),
            node("Row", { key: "c", props: { label: "third" } })
        ]
    });
    const after = node("List", {
        children: [
            node("Row", { key: "c", props: { label: "third" } }),
            node("Row", { key: "a", props: { label: "first" } }),
            node("Row", { key: "b", props: { label: "second" } })
        ]
    });
    const d = diffReactTrees(before, after);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.changed.length, 0);
    assert.strictEqual(d.unchangedCount, 4);
});

check("same-named siblings without keys pair by position", () => {
    const before = node("List", {
        children: [node("Item", { props: { n: 1 } }), node("Item", { props: { n: 2 } })]
    });
    const after = node("List", {
        children: [node("Item", { props: { n: 1 } }), node("Item", { props: { n: 99 } })]
    });
    const d = diffReactTrees(before, after);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.changed.length, 1);
    assert.strictEqual(d.changed[0].path, "List/Item[1]");
    assert.deepStrictEqual(d.changed[0].propDeltas, [{ prop: "n", before: 2, after: 99 }]);
    assert.strictEqual(d.unchangedCount, 2);
});

check("unchangedCount counts untouched matched nodes", () => {
    const tree = node("App", {
        children: [node("Shell", { children: [node("Sidebar"), node("Chat", { props: { channel: "general" } })] })]
    });
    const d = diffReactTrees(tree, tree);
    assert.strictEqual(d.unchangedCount, 4);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.changed.length, 0);
});

check("null before marks everything in after as added", () => {
    const after = node("App", { children: [node("Shell", { children: [node("Chat")] })] });
    const d = diffReactTrees(null, after);
    assert.deepStrictEqual(d.added.map(a => a.path), ["App", "App/Shell", "App/Shell/Chat"]);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.unchangedCount, 0);
});

check("null after marks everything in before as removed", () => {
    const before = node("App", { children: [node("Chat")] });
    const d = diffReactTrees(before, null);
    assert.deepStrictEqual(d.removed.map(r => r.path), ["App", "App/Chat"]);
    assert.strictEqual(d.added.length, 0);
});

check("both null is an empty diff", () => {
    const d = diffReactTrees(null, null);
    assert.deepStrictEqual(d, { added: [], removed: [], changed: [], unchangedCount: 0 });
});

check("root identity mismatch is a full remove plus a full add", () => {
    const d = diffReactTrees(node("OldRoot"), node("NewRoot"));
    assert.deepStrictEqual(d.removed, [{ path: "OldRoot", name: "OldRoot" }]);
    assert.deepStrictEqual(d.added, [{ path: "NewRoot", name: "NewRoot" }]);
    assert.strictEqual(d.unchangedCount, 0);
});

check("huge wide tree does not throw and respects the node cap", () => {
    const children: TreeNode[] = [];
    for (let i = 0; i < 8000; i++) children.push(node("Cell", { key: String(i) }));
    const wide = node("Grid", { children });
    const d = diffReactTrees(null, wide);
    assert.strictEqual(d.added.length, 5000);
});

check("very deep tree does not throw and respects the depth cap", () => {
    let deep: TreeNode = node("Leaf");
    for (let i = 0; i < 200; i++) deep = node("Layer", { children: [deep] });
    const d = diffReactTrees(deep, deep);
    assert.strictEqual(d.unchangedCount, 61);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
});

check("node cap yields partial results on matched walks without throwing", () => {
    const make = () => {
        const children: TreeNode[] = [];
        for (let i = 0; i < 7000; i++) children.push(node("Row", { key: String(i), props: { n: i } }));
        return node("Table", { children });
    };
    const d = diffReactTrees(make(), make());
    assert.strictEqual(d.unchangedCount, 5000);
    assert.strictEqual(d.changed.length, 0);
});

check("non-serializable prop values do not throw", () => {
    const cyclicA: Record<string, unknown> = {};
    cyclicA.self = cyclicA;
    const cyclicB: Record<string, unknown> = {};
    cyclicB.self = cyclicB;
    const before = node("Widget", { props: { ref: cyclicA, big: BigInt(1), fn: () => 1 } });
    const after = node("Widget", { props: { ref: cyclicB, big: BigInt(2), fn: "replaced" } });
    const d = diffReactTrees(before, after);
    assert.strictEqual(d.added.length + d.removed.length, 0);
    assert.strictEqual(d.changed.length, 1);
    const props = d.changed[0].propDeltas.map(p => p.prop);
    assert.ok(props.includes("big"));
    assert.ok(props.includes("fn"));
    assert.ok(!props.includes("ref"));
});

console.log(`\nreactTreeDiff: ${passed} checks passed`);
