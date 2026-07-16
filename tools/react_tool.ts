/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FiberNode, FoundComponent, HookInfo, ReactFiber, ReactToolArgs, ToolResult, TreeNode } from "../types";
import { COMPONENT_FIBER_TAGS, CSS_CLASS_CAPTURE_RE, FIBER_TAGS, LIMITS } from "./constants";
import * as u from "./utils";

function getReactRoot(): ReactFiber | null {
    const container = document.getElementById("app-mount");
    return container && u.fiberFromKey(container, "__reactContainer$");
}

function findElement(selector: string): Element | { error: true; message: string } {
    try {
        const el = document.querySelector(selector);
        return el ?? { error: true, message: `No element matches selector "${selector}"` };
    } catch (e) {
        return { error: true, message: `Invalid selector "${selector}": ${e instanceof Error ? e.message : "syntax error"}` };
    }
}

function walkFiberUp(fiber: ReactFiber | null, maxDepth: number, predicate: (f: ReactFiber) => boolean): ReactFiber | null {
    for (const { fiber: f } of u.fibersUp(fiber, maxDepth)) if (predicate(f)) return f;
    return null;
}

export async function handleReact(args: ReactToolArgs): Promise<ToolResult> {
    const { action, selector, componentName } = args;
    if (args.limit != null && args.limit < 1) return { error: true, message: "limit must be >= 1 (omit for default)" };
    if (args.depth != null && args.depth < 1) return { error: true, message: "depth must be >= 1 (omit for default)" };
    const maxDepth = u.clamp(args.depth, LIMITS.REACT.DEFAULT_DEPTH, 1, LIMITS.REACT.MAX_DEPTH);
    const direction = args.direction ?? "up";
    const includeProps = args.includeProps ?? false;
    const limit = u.clamp(args.limit, LIMITS.REACT.DEFAULT_LIMIT, 1, LIMITS.REACT.MAX_LIMIT);

    if (!action) return u.missingArg("action");

    const fiberMiss = (hasFiber: boolean, message: string, extra?: Record<string, unknown>) => ({ found: true, selector, hasFiber, ...extra, message });

    if (action === "find") {
        if (!componentName) return u.missingArg("componentName");
        if (componentName.length < 2) return { error: true, message: "componentName must be at least 2 characters" };

        const rootFiber = getReactRoot();
        if (!rootFiber) return { error: true, message: "React root not found" };

        const lowerName = componentName.toLowerCase();
        const includeByProps = args.includeByProps ?? true;

        const found: FoundComponent[] = [];
        const seenSelectors = new Set<string>();

        const elementToSelector = (el: Element): string => {
            const tag = el.tagName.toLowerCase();
            return el.id ? `#${el.id}` : el.classList?.[0] ? `${tag}.${el.classList[0]}` : tag;
        };

        const getSelectorForFiber = (f: ReactFiber): string => {
            for (let current: ReactFiber | null = f; current; current = current.child ?? null) {
                if (current.stateNode instanceof Element) return elementToSelector(current.stateNode);
            }
            for (const { fiber: current } of u.fibersUp(f.return ?? null, LIMITS.REACT.PARENT_SEARCH_DEPTH)) {
                if (current.stateNode instanceof Element) return elementToSelector(current.stateNode);
            }
            return "(no DOM element)";
        };

        const queue: Array<{ fiber: ReactFiber; depth: number }> = [{ fiber: rootFiber, depth: 0 }];
        let qHead = 0;
        let processed = 0;

        while (qHead < queue.length && processed < LIMITS.REACT.MAX_PROCESS && found.length < limit) {
            const { fiber: f, depth } = queue[qHead++];
            processed++;

            const info = u.getComponentInfo(f);
            const record = (dedupeKey: string, propKeys?: string[]) => {
                const selectorStr = getSelectorForFiber(f);
                const key = `${dedupeKey}:${selectorStr}`;
                if (seenSelectors.has(key)) return;
                seenSelectors.add(key);
                found.push({
                    name: info.name,
                    selector: selectorStr,
                    tagType: info.tagType,
                    fiberDepth: depth,
                    matchedBy: propKeys ? "props" : "name",
                    ...(propKeys && { propKeys: propKeys.slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW) }),
                });
            };
            if (info.name?.toLowerCase().includes(lowerName)) record(`name:${info.name}`);
            else if (includeByProps && COMPONENT_FIBER_TAGS.has(f.tag) && f.memoizedProps) {
                const matchingProps = Object.keys(f.memoizedProps).filter(k => k !== "children" && k.length > LIMITS.REACT.PROP_FILTER_MIN_LENGTH && k.toLowerCase().includes(lowerName));
                if (matchingProps.length) record(`props:${matchingProps.sort().join(",")}`, matchingProps);
            }

            if (f.child) queue.push({ fiber: f.child, depth: depth + 1 });
            if (f.sibling) queue.push({ fiber: f.sibling, depth });
        }

        found.sort((a, b) => (a.matchedBy !== b.matchedBy ? (a.matchedBy === "name" ? -1 : 1) : a.fiberDepth - b.fiberDepth));

        return {
            query: componentName,
            found: found.length,
            components: found,
            fibersSearched: processed,
            note: !found.length ? `No matches for "${componentName}"` : found.length >= limit ? `Limited to ${limit}` : undefined,
        };
    }

    if (!selector) return { error: true, message: `selector required for "${action}"` };

    const elResult = findElement(selector);
    if ("error" in elResult) return elResult;
    const el = elResult;

    if (action === "query") {
        const elements = document.querySelectorAll(selector);
        const results = Array.from(elements).slice(0, limit).map((elem, index) => {
            const rect = elem.getBoundingClientRect();
            const attrs: Record<string, string> = {};
            for (const attr of elem.attributes) if (!attr.name.startsWith("__react") && attrs[attr.name] === undefined) attrs[attr.name] = attr.value.slice(0, LIMITS.REACT.ATTR_VALUE_SLICE);
            const classStr = elem.className?.toString() ?? "";
            const cssMatch = CSS_CLASS_CAPTURE_RE.exec(classStr);
            return {
                index,
                tagName: elem.tagName,
                id: elem.id || undefined,
                className: classStr.slice(0, LIMITS.REACT.CLASS_NAME_SLICE) || null,
                attributes: attrs,
                rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                ...(cssMatch && { cssHint: `module className="${cssMatch[1]}" for CSS module lookup` }),
                ...(args.includeText && { text: elem.textContent?.slice(0, LIMITS.REACT.ATTR_VALUE_SLICE) || "" }),
            };
        });

        return { selector, total: elements.length, returned: results.length, elements: results, note: elements.length > limit ? `${limit} of ${elements.length} shown` : undefined };
    }

    if (action === "styles") {
        const { properties } = args;
        const computed = window.getComputedStyle(el);
        const styles: Record<string, string> = {};

        if (properties?.length) {
            for (const prop of properties.slice(0, LIMITS.REACT.MAX_STYLES)) {
                styles[prop] = computed.getPropertyValue(prop) || "(not set)";
            }
        } else {
            const defaultStyles = window.getComputedStyle(document.createElement(el.tagName));
            for (let i = 0; i < computed.length && Object.keys(styles).length < LIMITS.REACT.MAX_STYLES; i++) {
                const prop = computed[i];
                if (prop.startsWith("-webkit-") || prop.startsWith("-moz-")) continue;
                const value = computed.getPropertyValue(prop);
                if (value && value !== defaultStyles.getPropertyValue(prop)) styles[prop] = value;
            }
        }

        return { found: true, selector, tagName: el.tagName, styleCount: Object.keys(styles).length, styles };
    }

    if (action === "tree") {
        const breadth = u.clamp(args.breadth, LIMITS.REACT.DEFAULT_BREADTH, 1, LIMITS.REACT.MAX_BREADTH);

        const buildNode = (node: Element, d: number): TreeNode => {
            const info: TreeNode = { tag: node.tagName.toLowerCase() };
            if (node.id) info.id = node.id;
            if (node.classList.length) info.classes = [...node.classList].slice(0, LIMITS.REACT.MAX_CLASS_LIST);
            if (!node.children.length && node.textContent) info.text = node.textContent.slice(0, LIMITS.REACT.TREE_TEXT_SLICE);

            if (d > 0 && node.children.length) {
                const childCount = node.children.length;
                info.children = [];
                for (let i = 0; i < Math.min(childCount, breadth); i++) {
                    info.children.push(buildNode(node.children[i], d - 1));
                }
                if (childCount > breadth) info.moreChildren = childCount - breadth;
            }

            return info;
        };

        return { found: true, selector, tree: buildNode(el, maxDepth) };
    }

    if (action === "path") {
        const parts: string[] = [];
        let current: Element | null = el;

        while (current && current !== document.body && parts.length < LIMITS.REACT.MAX_PATH_DEPTH) {
            const tag = current.tagName.toLowerCase();
            let part = tag;

            if (current.id) part += `#${current.id}`;
            else if (current.classList[0]) part += `.${current.classList[0]}`;
            else if (current.parentElement && current.parentElement.querySelectorAll(`:scope > ${tag}`).length > 1) {
                let nth = 1;
                for (let s = current.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === current.tagName) nth++;
                part += `:nth-of-type(${nth})`;
            }

            parts.unshift(part);
            current = current.parentElement;
        }

        return { found: true, selector, path: parts.join(" > "), uniqueSelector: parts.slice(-3).join(" > ") };
    }

    const fiber = u.getFiber(el);

    if (action === "source") {
        if (!fiber) return fiberMiss(false, "No fiber found");
        const { reverse } = u.buildDependencyGraph();
        type SourceCandidate = { name: string | null; moduleId: string; exportKey: string; hint: string | null; importedByCount: number; likelyPrimitive: boolean };
        const stack: SourceCandidate[] = [];
        const seen = new Set<string>();
        for (const { fiber: f } of u.fibersUp(fiber, maxDepth)) {
            const type = f.type as unknown;
            if (!type || (typeof type !== "object" && typeof type !== "function")) continue;
            const inner = u.innerType(type as { type?: unknown; render?: unknown });
            const hit = u.lookupIdentity(inner) ?? u.lookupIdentity(type);
            if (hit && !seen.has(`${hit.id}:${hit.key}`)) {
                seen.add(`${hit.id}:${hit.key}`);
                const importedByCount = reverse.get(hit.id)?.length ?? 0;
                stack.push({ name: u.getComponentInfo(f).name, moduleId: hit.id, exportKey: hit.key, hint: u.getModuleHint(hit.id), importedByCount, likelyPrimitive: importedByCount >= LIMITS.REACT.PRIMITIVE_IMPORTED_BY });
                if (stack.length >= limit) break;
            }
        }
        if (!stack.length) return { found: true, selector, hasFiber: true, stack: [], message: "No ancestor fiber resolved to a webpack module (component may be inline/anonymous)" };
        const nearest = stack[0];
        const patchedBy = u.getModulePatchedBy(nearest.moduleId);
        const ranked = stack
            .map((c, i) => ({ c, i }))
            .sort((a, b) => (Number(a.c.likelyPrimitive) - Number(b.c.likelyPrimitive)) || (a.c.importedByCount - b.c.importedByCount) || (a.i - b.i))
            .map(x => x.c);
        const allPrimitives = stack.every(c => c.likelyPrimitive);
        const note = allPrimitives
            ? "Every candidate looks like a design-system primitive. Pivot to intl.search on the element label."
            : "Prefer the lowest-importedByCount non-primitive in ranked[], not nearest.";
        return { found: true, selector, nearest: { ...nearest, patchedBy: patchedBy.length ? patchedBy : undefined }, ranked, stack, note };
    }

    if (action === "fiber") {
        if (!fiber) return fiberMiss(false, "No fiber found");
        if (direction !== "up" && direction !== "down") return { error: true, message: `Invalid direction "${direction}"` };

        const nodes: FiberNode[] = [];
        const buildNode = (f: ReactFiber, depth: number): FiberNode => {
            const info = u.getComponentInfo(f);
            const node: FiberNode = { tagType: info.tagType, depth };
            if (info.name) node.name = info.name;
            else if (info.isMinified) node.minified = true;
            if (includeProps && f.memoizedProps) {
                node.propKeys = Object.keys(f.memoizedProps).filter(k => k.length > 1).slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW);
            }
            if (f.memoizedState) node.hasState = true;
            return node;
        };

        if (direction === "up") {
            for (const { fiber: f, depth } of u.fibersUp(fiber, maxDepth)) {
                if (nodes.length >= limit) break;
                nodes.push(buildNode(f, depth));
            }
        } else {
            const walkDown = (f: ReactFiber, d: number) => {
                if (d > maxDepth || nodes.length >= limit) return;
                nodes.push(buildNode(f, d));
                if (f.child) walkDown(f.child, d + 1);
                if (f.sibling) walkDown(f.sibling, d);
            };
            walkDown(fiber, 0);
        }

        return { found: true, selector, direction, nodeCount: nodes.length, fiber: nodes };
    }

    if (action === "props") {
        if (!fiber) return fiberMiss(false, "No fiber found", { props: null });

        const targetFiber = walkFiberUp(
            fiber,
            maxDepth,
            f => !!f.memoizedProps && Object.keys(f.memoizedProps).length > 0 && (!!u.getComponentName(f) || Object.keys(f.memoizedProps).some(k => k.length > 2)),
        );
        if (!targetFiber) return fiberMiss(true, "No component with props found", { props: null });

        const props = Object.fromEntries(Object.entries(targetFiber.memoizedProps ?? {}).map(([k, v]) => [k, u.serializeValue(v)]));

        return { found: true, selector, componentName: u.getComponentName(targetFiber), props };
    }

    if (action === "hooks") {
        if (!fiber) return fiberMiss(false, "No fiber found", { hooks: null });

        const targetFiber = walkFiberUp(fiber, maxDepth, f => f.tag === 0 && !!f.memoizedState);
        if (!targetFiber) return fiberMiss(true, "No hooks found", { hooks: null });

        const hooks: HookInfo[] = [];
        for (let hs = targetFiber.memoizedState; hs && hooks.length < LIMITS.REACT.MAX_HOOKS; hs = hs.next ?? null) {
            const hookType = u.getHookType(hs);
            const hook: HookInfo = { index: hooks.length, type: hookType };

            if (hookType === "useState" || hookType === "useReducer") {
                hook.value = u.serializeValue(hs.memoizedState);
            } else if (hookType === "useRef") {
                hook.value = u.serializeValue((hs.memoizedState as { current?: unknown })?.current);
            } else if (hookType === "useMemo") {
                hook.value = u.serializeValue((hs.memoizedState as unknown[])?.[0]);
                hook.deps = hs.deps?.length ?? 0;
            } else if (hookType === "useCallback" || hookType.includes("Effect")) {
                hook.deps = hs.deps?.length ?? 0;
            }

            hooks.push(hook);
        }

        return { found: true, selector, componentName: u.getComponentName(targetFiber), hookCount: hooks.length, hooks };
    }

    if (action === "contexts") {
        if (!fiber) return fiberMiss(false, "No fiber found", { contexts: [] });

        const contexts: Array<{ displayName: string | null; valueKeys: string[] | null; sample: Record<string, unknown> }> = [];

        for (const { fiber: current } of u.fibersUp(fiber, maxDepth)) {
            if (contexts.length >= limit) break;
            if (current.tag !== FIBER_TAGS.CONTEXT_PROVIDER) continue;
            const value = current.memoizedProps?.value;
            if (!value || typeof value !== "object") continue;
            const keys = Object.keys(value);
            contexts.push({
                displayName: (current.type?._context ?? current.type)?.displayName ?? null,
                valueKeys: keys.slice(0, LIMITS.REACT.CONTEXT_VALUE_KEYS),
                sample: Object.fromEntries(keys.slice(0, LIMITS.REACT.CONTEXT_SAMPLE_KEYS).map(k => [k, u.serializeValue((value as Record<string, unknown>)[k])])),
            });
        }

        return { found: true, selector, contextCount: contexts.length, contexts, note: !contexts.length ? "No contexts found" : undefined };
    }

    if (action === "state") {
        if (!fiber) return fiberMiss(false, "No fiber found", { state: null });

        const targetFiber = walkFiberUp(fiber, maxDepth, f => (f.tag === 1 && !!f.stateNode?.state) || (f.tag === 0 && !!f.memoizedState));
        if (!targetFiber) return fiberMiss(true, "No stateful component found", { state: null });

        const info = u.getComponentInfo(targetFiber);

        if (targetFiber.tag === 1) {
            return { found: true, selector, componentName: info.name, tagType: info.tagType, stateType: "class", state: u.serializeValue(targetFiber.stateNode?.state) };
        }

        const stateValues: unknown[] = [];
        for (let hs = targetFiber.memoizedState; hs && stateValues.length < LIMITS.REACT.STATE_VALUES_MAX; hs = hs.next ?? null) {
            if (hs.queue?.dispatch) stateValues.push(u.serializeValue(hs.memoizedState));
        }

        return { found: true, selector, componentName: info.name, tagType: info.tagType, stateType: "hooks", stateCount: stateValues.length, state: stateValues };
    }

    return { error: true, message: `Unknown action "${action}"` };
}
