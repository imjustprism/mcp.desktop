/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FiberMemoizedState, FiberNode, FoundComponent, HookInfo, ReactFiber, ReactToolArgs, ToolResult, TreeNode } from "../types";
import { CSS_CLASS_CAPTURE_RE, INTERESTING_PROP_KEYWORDS, LIMITS } from "./constants";
import { getComponentInfo, getComponentName, getFiber, getHookType, serializeValue } from "./utils";

function getReactRoot(): ReactFiber | null {
    const container = document.getElementById("app-mount");
    if (!container) return null;
    const rootKey = Object.keys(container).find(k => k.startsWith("__reactContainer$"));
    return rootKey ? (container as unknown as Record<string, ReactFiber>)[rootKey] : null;
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
    let current = fiber;
    let depth = 0;
    while (current && depth < maxDepth) {
        if (predicate(current)) return current;
        current = current.return ?? null;
        depth++;
    }
    return null;
}

export async function handleReactTool(args: ReactToolArgs): Promise<ToolResult> {
    const { action, selector, componentName } = args;
    const maxDepth = Math.min(Math.max(args.depth ?? 10, 1), LIMITS.REACT.MAX_DEPTH);
    const direction = args.direction ?? "up";
    const includeProps = args.includeProps ?? false;
    const limit = Math.min(Math.max(args.limit ?? 20, 1), LIMITS.REACT.MAX_LIMIT);

    if (!action) return { error: true, message: "action required" };

    if (action === "find") {
        if (!componentName) return { error: true, message: "componentName required for find" };
        if (componentName.length < 2) return { error: true, message: "componentName must be at least 2 characters" };

        const rootFiber = getReactRoot();
        if (!rootFiber) return { error: true, message: "React root not found" };

        const lowerName = componentName.toLowerCase();
        const includeByProps = args.includeByProps ?? true;

        const found: FoundComponent[] = [];
        const seenSelectors = new Set<string>();

        const getSelectorForFiber = (f: ReactFiber): string => {
            let selectorStr = "";
            let current: ReactFiber | null = f;

            while (current && !selectorStr) {
                if (current.stateNode instanceof Element) {
                    const el = current.stateNode;
                    const tag = el.tagName.toLowerCase();
                    selectorStr = el.id ? `#${el.id}` : el.classList?.[0] ? `${tag}.${el.classList[0]}` : tag;
                }
                current = current.child ?? null;
            }

            if (!selectorStr) {
                current = f.return ?? null;
                let upDepth = 0;
                while (current && !selectorStr && upDepth < LIMITS.REACT.PARENT_SEARCH_DEPTH) {
                    if (current.stateNode instanceof Element) {
                        const el = current.stateNode;
                        const tag = el.tagName.toLowerCase();
                        selectorStr = el.id ? `#${el.id}` : el.classList?.[0] ? `${tag}.${el.classList[0]}` : tag;
                    }
                    current = current.return ?? null;
                    upDepth++;
                }
            }

            return selectorStr || "(no DOM element)";
        };

        const queue: Array<{ fiber: ReactFiber; depth: number }> = [{ fiber: rootFiber, depth: 0 }];
        let processed = 0;

        while (queue.length && processed < LIMITS.REACT.MAX_PROCESS && found.length < limit) {
            const { fiber: f, depth } = queue.shift()!;
            processed++;

            const info = getComponentInfo(f);
            const isComponentFiber = f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15;

            if (info.name?.toLowerCase().includes(lowerName)) {
                const selectorStr = getSelectorForFiber(f);
                const key = `name:${info.name}:${selectorStr}`;
                if (!seenSelectors.has(key)) {
                    seenSelectors.add(key);
                    found.push({ name: info.name, selector: selectorStr, tagType: info.tagType, fiberDepth: depth, matchedBy: "name" });
                }
            } else if (includeByProps && isComponentFiber && f.memoizedProps) {
                const props = f.memoizedProps as Record<string, unknown>;
                const propKeys = Object.keys(props).filter(k => k !== "children" && k.length > LIMITS.REACT.PROP_FILTER_MIN_LENGTH);
                const matchingProps = propKeys.filter(k => k.toLowerCase().includes(lowerName));

                if (matchingProps.length) {
                    const selectorStr = getSelectorForFiber(f);
                    const key = `props:${matchingProps.sort().join(",")}:${selectorStr}`;
                    if (!seenSelectors.has(key)) {
                        seenSelectors.add(key);
                        found.push({ name: info.name, selector: selectorStr, tagType: info.tagType, fiberDepth: depth, matchedBy: "props", propKeys: matchingProps.slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW) });
                    }
                }
            }

            if (f.child) queue.push({ fiber: f.child, depth: depth + 1 });
            if (f.sibling) queue.push({ fiber: f.sibling, depth });
        }

        found.sort((a, b) => a.matchedBy !== b.matchedBy ? (a.matchedBy === "name" ? -1 : 1) : a.fiberDepth - b.fiberDepth);

        return {
            query: componentName,
            found: found.length,
            components: found,
            fibersSearched: processed,
            note: !found.length ? `No matches for "${componentName}"` : found.length >= limit ? `Limited to ${limit}` : undefined
        };
    }

    if (action === "root") {
        const rootFiber = getReactRoot();
        if (!rootFiber) return { error: true, message: "React root not found" };

        const tagCounts: Record<string, number> = {};
        const namedComponents: string[] = [];
        const interestingPropPatterns = new Set<string>();
        const queue: ReactFiber[] = [rootFiber];
        let processed = 0;

        while (queue.length && processed < LIMITS.REACT.MAX_PROCESS) {
            const f = queue.shift()!;
            processed++;

            const info = getComponentInfo(f);
            tagCounts[info.tagType] = (tagCounts[info.tagType] ?? 0) + 1;

            if (info.name && namedComponents.length < LIMITS.REACT.MAX_NAMED_COMPONENTS && !namedComponents.includes(info.name)) {
                namedComponents.push(info.name);
            }

            if ((f.tag === 0 || f.tag === 1) && f.memoizedProps && interestingPropPatterns.size < LIMITS.REACT.MAX_STYLES) {
                const props = f.memoizedProps as Record<string, unknown>;
                for (const key of Object.keys(props).filter(k => k !== "children" && k.length > LIMITS.REACT.PROP_FILTER_MIN_LENGTH)) {
                    const lower = key.toLowerCase();
                    if ([...INTERESTING_PROP_KEYWORDS].some(kw => lower.includes(kw))) {
                        interestingPropPatterns.add(key);
                    }
                }
            }

            if (f.child) queue.push(f.child);
            if (f.sibling) queue.push(f.sibling);
        }

        const mode = rootFiber.mode ?? 0;
        return {
            found: true,
            fiberCount: processed,
            mode: { raw: mode, concurrent: !!(mode & 1), strict: !!(mode & 8) },
            tagCounts,
            namedComponents: namedComponents.sort(),
            searchableProps: [...interestingPropPatterns].sort(),
            note: processed >= LIMITS.REACT.MAX_PROCESS ? `Stopped at ${LIMITS.REACT.MAX_PROCESS} nodes` : undefined
        };
    }

    if (!selector) return { error: true, message: `selector required for "${action}"` };

    const elResult = findElement(selector);
    if ("error" in elResult) return elResult;
    const el = elResult;

    if (action === "query") {
        const includeText = args.includeText ?? false;

        let elements: NodeListOf<Element>;
        try {
            elements = document.querySelectorAll(selector);
        } catch (e) {
            return { error: true, message: `Invalid selector "${selector}": ${e instanceof Error ? e.message : "syntax error"}` };
        }

        const results: Array<{ index: number; tagName: string; id: string | null; className: string | null; cssHint?: string; attributes: Record<string, string>; text?: string; rect: { top: number; left: number; width: number; height: number } }> = [];

        for (let i = 0; i < Math.min(elements.length, limit); i++) {
            const elem = elements[i];
            const rect = elem.getBoundingClientRect();
            const attrs: Record<string, string> = {};

            for (const attr of elem.attributes) {
                if (!attr.name.startsWith("__react") && attrs[attr.name] === undefined) {
                    attrs[attr.name] = attr.value.slice(0, LIMITS.REACT.ATTR_VALUE_SLICE);
                }
            }

            const classStr = elem.className?.toString() ?? "";
            const entry: typeof results[0] = {
                index: i,
                tagName: elem.tagName,
                id: elem.id || null,
                className: classStr.slice(0, LIMITS.REACT.CLASS_NAME_SLICE) || null,
                attributes: attrs,
                rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
            };

            const cssMatch = CSS_CLASS_CAPTURE_RE.exec(classStr);
            if (cssMatch) entry.cssHint = `module className="${cssMatch[1]}" for CSS module lookup`;

            if (includeText) entry.text = elem.textContent?.slice(0, LIMITS.REACT.ATTR_VALUE_SLICE) || "";
            results.push(entry);
        }

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

    if (action === "modify") {
        const { styles, addClass, removeClass, setAttribute } = args;

        if (!styles && !addClass && !removeClass && !setAttribute) {
            return { error: true, message: "Provide styles, addClass, removeClass, or setAttribute" };
        }

        const htmlEl = el as HTMLElement;
        const changes: string[] = [];

        if (styles) {
            for (const [prop, value] of Object.entries(styles).slice(0, LIMITS.REACT.STYLE_MODIFY_MAX)) {
                htmlEl.style.setProperty(prop, value);
                changes.push(`style.${prop} = ${value}`);
            }
        }

        if (addClass) {
            htmlEl.classList.add(...addClass.split(" ").filter(Boolean));
            changes.push(`added class: ${addClass}`);
        }

        if (removeClass) {
            htmlEl.classList.remove(...removeClass.split(" ").filter(Boolean));
            changes.push(`removed class: ${removeClass}`);
        }

        if (setAttribute) {
            for (const [attr, value] of Object.entries(setAttribute).slice(0, LIMITS.REACT.SET_ATTRIBUTE_MAX)) {
                htmlEl.setAttribute(attr, value);
                changes.push(`${attr} = ${value}`);
            }
        }

        return { found: true, selector, changes, note: "Temporary, lost on re-render" };
    }

    if (action === "tree") {
        const breadth = Math.min(Math.max(args.breadth ?? 10, 1), LIMITS.REACT.MAX_BREADTH);

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

    if (action === "text") {
        const textContent = el.textContent?.trim().slice(0, LIMITS.REACT.TEXT_CONTENT_MAX) ?? "";
        const childTexts: Array<{ tag: string; text: string }> = [];

        for (let i = 0; i < Math.min(el.children.length, limit); i++) {
            const text = el.children[i].textContent?.trim();
            if (text) childTexts.push({ tag: el.children[i].tagName.toLowerCase(), text: text.slice(0, LIMITS.REACT.CHILD_TEXT_SLICE) });
        }

        return { found: true, selector, textLength: textContent.length, text: textContent.slice(0, LIMITS.REACT.TEXT_PREVIEW), childTexts: childTexts.slice(0, LIMITS.REACT.CHILD_TEXTS_MAX) };
    }

    if (action === "path") {
        const parts: string[] = [];
        let current: Element | null = el;

        while (current && current !== document.body && parts.length < LIMITS.REACT.MAX_PATH_DEPTH) {
            const tag = current.tagName.toLowerCase();
            let part = tag;

            if (current.id) {
                part += `#${current.id}`;
            } else if (current.classList[0]) {
                part += `.${current.classList[0]}`;
            } else {
                const parent = current.parentElement;
                if (parent) {
                    let nth = 1;
                    for (const sibling of parent.children) {
                        if (sibling === current) break;
                        if (sibling.tagName === current.tagName) nth++;
                    }
                    if (parent.querySelectorAll(`:scope > ${tag}`).length > 1) part += `:nth-of-type(${nth})`;
                }
            }

            parts.unshift(part);
            current = current.parentElement;
        }

        return { found: true, selector, path: parts.join(" > "), uniqueSelector: parts.slice(-3).join(" > ") };
    }

    const fiber = getFiber(el);

    if (action === "fiber") {
        if (!fiber) return { found: true, selector, hasFiber: false, message: "No fiber found" };
        if (direction !== "up" && direction !== "down") return { error: true, message: `Invalid direction "${direction}"` };

        const nodes: FiberNode[] = [];

        if (direction === "up") {
            let current: ReactFiber | null = fiber;
            let depth = 0;
            while (current && depth < maxDepth) {
                const info = getComponentInfo(current);
                const node: FiberNode = { tagType: info.tagType, depth };
                if (info.name) node.name = info.name;
                else if (info.isMinified) node.minified = true;
                if (includeProps && current.memoizedProps) {
                    node.propKeys = Object.keys(current.memoizedProps).filter(k => k.length > 1).slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW);
                }
                if (current.memoizedState) node.hasState = true;
                nodes.push(node);
                current = current.return ?? null;
                depth++;
            }
        } else {
            const walkDown = (f: ReactFiber, d: number) => {
                if (d > maxDepth || nodes.length >= limit) return;
                const info = getComponentInfo(f);
                const node: FiberNode = { tagType: info.tagType, depth: d };
                if (info.name) node.name = info.name;
                else if (info.isMinified) node.minified = true;
                if (includeProps && f.memoizedProps) {
                    node.propKeys = Object.keys(f.memoizedProps).filter(k => k.length > 1).slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW);
                }
                if (f.memoizedState) node.hasState = true;
                nodes.push(node);
                if (f.child) walkDown(f.child, d + 1);
                if (f.sibling) walkDown(f.sibling, d);
            };
            walkDown(fiber, 0);
        }

        return { found: true, selector, direction, nodeCount: nodes.length, fiber: nodes };
    }

    if (action === "props") {
        if (!fiber) return { found: true, selector, hasFiber: false, props: null, message: "No fiber found" };

        const targetFiber = walkFiberUp(fiber, maxDepth, f =>
            !!f.memoizedProps && Object.keys(f.memoizedProps).length > 0 &&
            (!!getComponentName(f) || Object.keys(f.memoizedProps).some(k => k.length > 2))
        );
        if (!targetFiber) return { found: true, selector, hasFiber: true, props: null, message: "No component with props found" };

        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(targetFiber.memoizedProps ?? {})) {
            props[k] = serializeValue(v);
        }

        return { found: true, selector, componentName: getComponentName(targetFiber), props };
    }

    if (action === "hooks") {
        if (!fiber) return { found: true, selector, hasFiber: false, hooks: null, message: "No fiber found" };

        const targetFiber = walkFiberUp(fiber, maxDepth, f => f.tag === 0 && !!f.memoizedState);
        if (!targetFiber) return { found: true, selector, hasFiber: true, hooks: null, message: "No hooks found" };

        const hooks: HookInfo[] = [];
        let hookState = targetFiber.memoizedState as FiberMemoizedState | null;
        let i = 0;

        while (hookState && i < LIMITS.REACT.MAX_HOOKS) {
            const hookType = getHookType(hookState);
            const hook: HookInfo = { index: i, type: hookType };

            if (hookType === "useState" || hookType === "useReducer") {
                hook.value = serializeValue(hookState.memoizedState);
            } else if (hookType === "useRef") {
                hook.value = serializeValue((hookState.memoizedState as { current?: unknown })?.current);
            } else if (hookType === "useMemo") {
                const memoState = hookState.memoizedState as unknown[];
                hook.value = serializeValue(memoState?.[0]);
                hook.deps = (hookState.deps as unknown[] | null)?.length ?? 0;
            } else if (hookType === "useCallback") {
                hook.deps = (hookState.deps as unknown[] | null)?.length ?? 0;
            } else if (hookType.includes("Effect")) {
                hook.deps = (hookState.deps as unknown[] | null)?.length ?? 0;
            }

            hooks.push(hook);
            hookState = hookState.next ?? null;
            i++;
        }

        return { found: true, selector, componentName: getComponentName(targetFiber), hookCount: hooks.length, hooks };
    }

    if (action === "contexts") {
        if (!fiber) return { found: true, selector, hasFiber: false, contexts: [], message: "No fiber found" };

        const contexts: Array<{ displayName: string | null; valueKeys: string[] | null; sample: Record<string, unknown> }> = [];
        let current: ReactFiber | null = fiber;
        let depth = 0;

        while (current && depth < maxDepth && contexts.length < limit) {
            if (current.tag === 10) {
                const contextType = current.type?._context ?? current.type;
                const value = current.memoizedProps?.value;

                if (value && typeof value === "object") {
                    const keys = Object.keys(value);
                    const sample: Record<string, unknown> = {};
                    for (const k of keys.slice(0, LIMITS.REACT.CONTEXT_SAMPLE_KEYS)) sample[k] = serializeValue((value as Record<string, unknown>)[k]);

                    contexts.push({ displayName: contextType?.displayName ?? null, valueKeys: keys.slice(0, LIMITS.REACT.CONTEXT_VALUE_KEYS), sample });
                }
            }
            current = current.return ?? null;
            depth++;
        }

        return { found: true, selector, contextCount: contexts.length, contexts, note: !contexts.length ? "No contexts found" : undefined };
    }

    if (action === "forceUpdate") {
        if (!fiber) return { found: true, selector, success: false, message: "No fiber found" };

        const targetFiber = walkFiberUp(fiber, maxDepth, f =>
            (f.tag === 1 && !!f.stateNode?.forceUpdate) ||
            (f.tag === 0 && !!(f.memoizedState as FiberMemoizedState | null)?.queue?.dispatch)
        );

        if (!targetFiber) return { found: true, selector, success: false, message: "No updatable component found" };

        if (targetFiber.tag === 1) targetFiber.stateNode!.forceUpdate!();
        else (targetFiber.memoizedState as FiberMemoizedState).queue!.dispatch!({});

        return { found: true, selector, success: true, component: getComponentName(targetFiber), message: "Component re-rendered" };
    }

    if (action === "state") {
        if (!fiber) return { found: true, selector, hasFiber: false, state: null, message: "No fiber found" };

        const targetFiber = walkFiberUp(fiber, maxDepth, f =>
            (f.tag === 1 && !!f.stateNode?.state) || (f.tag === 0 && !!f.memoizedState)
        );
        if (!targetFiber) return { found: true, selector, hasFiber: true, state: null, message: "No stateful component found" };

        const info = getComponentInfo(targetFiber);

        if (targetFiber.tag === 1) {
            return { found: true, selector, componentName: info.name, tagType: info.tagType, stateType: "class", state: serializeValue(targetFiber.stateNode?.state) };
        }

        const stateValues: unknown[] = [];
        let hookState = targetFiber.memoizedState as FiberMemoizedState | null;

        while (hookState && stateValues.length < LIMITS.REACT.STATE_VALUES_MAX) {
            if (hookState.queue?.dispatch) stateValues.push(serializeValue(hookState.memoizedState));
            hookState = hookState.next ?? null;
        }

        return { found: true, selector, componentName: info.name, tagType: info.tagType, stateType: "hooks", stateCount: stateValues.length, state: stateValues };
    }

    if (action === "owner") {
        if (!fiber) return { found: true, selector, hasFiber: false, owners: [], message: "No fiber found" };

        const owners: Array<{ name: string | null; tagType: string; depth: number; propKeys?: string[] }> = [];
        let current: ReactFiber | null = fiber._debugOwner ?? fiber.return ?? null;
        let depth = 0;

        while (current && depth < maxDepth && owners.length < limit) {
            const info = getComponentInfo(current);

            if (info.tagType !== "DOM" && info.tagType !== "Text") {
                const entry: { name: string | null; tagType: string; depth: number; propKeys?: string[] } = { name: info.name, tagType: info.tagType, depth };
                if (includeProps && current.memoizedProps) {
                    entry.propKeys = Object.keys(current.memoizedProps).filter(k => k !== "children" && k.length > 1).slice(0, LIMITS.REACT.MAX_PROP_KEYS_PREVIEW);
                }
                owners.push(entry);
            }

            current = current._debugOwner ?? current.return ?? null;
            depth++;
        }

        return { found: true, selector, ownerCount: owners.length, owners, note: !owners.length ? "No owners found" : undefined };
    }

    return { error: true, message: `Unknown action "${action}"` };
}
