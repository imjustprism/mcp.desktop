import { GraphToolArgs, ToolResult } from "../types";
import { DEFAULT_TOOL_LIMIT } from "./constants";
import * as u from "./utils";

function bfsPath(graph: Map<string, string[]>, from: string, to: string, maxDepth: number): string[] | null {
    if (from === to) return [from];
    const queue: string[][] = [[from]];
    const seen = new Set<string>([from]);
    for (let i = 0; i < queue.length; i++) {
        const path = queue[i];
        if (path.length > maxDepth) break;
        for (const next of graph.get(path[path.length - 1]) ?? []) {
            if (seen.has(next)) continue;
            const extended = [...path, next];
            if (next === to) return extended;
            seen.add(next);
            queue.push(extended);
        }
    }
    return null;
}

export async function handleGraph(args: GraphToolArgs): Promise<ToolResult> {
    const { action, id, to } = args;
    const limit = u.clamp(args.limit, DEFAULT_TOOL_LIMIT, 1, 200);
    if (!id) return u.missingArg("id");
    if (!u.getModuleSource(id)) return u.moduleNotFound(id);
    if (action === "exports") return { id, publicExports: u.parsePublicExports(id) };
    const { forward, reverse } = u.buildDependencyGraph();
    const node = (x: string) => ({ id: x, hint: u.getModuleHint(x) });
    const decorate = (ids: string[]) => ids.slice(0, limit).map(node);

    if (!action || action === "imports" || action === "importedBy") {
        const direction = action === "importedBy" ? "importedBy" : "imports";
        const deps = (direction === "imports" ? forward : reverse).get(id) ?? [];
        return { id, direction, count: deps.length, edges: decorate(deps), truncated: deps.length > limit ? true : undefined };
    }

    if (action === "path") {
        if (!to) return u.missingArg("to");
        const depth = u.clamp(args.depth, 12, 1, 50);
        const fwd = bfsPath(forward, id, to, depth);
        if (fwd) return { from: id, to, direction: "imports", length: fwd.length - 1, hops: fwd.map(node) };
        const rev = bfsPath(reverse, id, to, depth);
        if (rev) return { from: id, to, direction: "importedBy", length: rev.length - 1, hops: rev.reverse().map(node) };
        return { from: id, to, found: false, message: `No dependency path within depth ${depth}` };
    }

    if (action === "neighborhood") {
        const budget = 60;
        const nodes = new Set<string>([id]);
        const queue: string[] = [id];
        while (queue.length && nodes.size < budget) {
            const cur = queue.shift()!;
            for (const n of [...(forward.get(cur) ?? []), ...(reverse.get(cur) ?? [])]) {
                if (!nodes.has(n) && nodes.size < budget) { nodes.add(n); queue.push(n); }
            }
        }
        const edges: Array<[string, string]> = [];
        for (const n of nodes) for (const d of forward.get(n) ?? []) if (nodes.has(d)) edges.push([n, d]);
        return { id, nodeCount: nodes.size, nodes: [...nodes].map(node), edges, truncated: queue.length > 0 ? true : undefined };
    }

    return { error: true, message: "action: imports, importedBy, path, neighborhood, exports" };
}
