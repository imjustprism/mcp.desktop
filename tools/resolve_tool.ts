import { escapeRegExp } from "@utils/text";

import { ResolveToolArgs, ToolResult } from "../types";
import { findAll, resolveStore } from "../webpack";
import { DEFAULT_TOOL_LIMIT, INTL_HASH_FULL_RE } from "./constants";
import * as u from "./utils";

export async function handleResolve(args: ResolveToolArgs): Promise<ToolResult> {
    const landmark = args.landmark?.trim();
    if (!landmark) return u.missingArg("landmark");
    const limit = u.clamp(args.limit, DEFAULT_TOOL_LIMIT, 1, 200);
    const decorate = (ids: string[]) => ids.slice(0, limit).map(id => ({ id, hint: u.getModuleHint(id) }));

    if (INTL_HASH_FULL_RE.test(landmark)) {
        const key = u.getIntlKeyFromHash(landmark);
        const bracket = `.t["${landmark}"]`;
        const dotRe = new RegExp(String.raw`\.t\.${escapeRegExp(landmark)}(?![A-Za-z0-9+/])`);
        const uses = (src: string) => src.includes(bracket) || dotRe.test(src);
        const modules = u.findModuleIds(uses, limit);
        if (key || modules.length) return { landmark, type: "intlHash", intlKey: key, find: u.intlFind(landmark, key), moduleCount: modules.length, modules: decorate(modules) };
    }

    const cssMatch = /^(?:[a-z][\w-]*_)?([a-f0-9]{6})$/i.exec(landmark);
    if (cssMatch) {
        const suffix = cssMatch[1];
        const { modules } = u.getCSSIndex();
        const hits: Array<{ id: string; hint: string | null; classNames: string[] }> = [];
        for (const [modId, info] of modules) {
            const classNames = Object.values(info.classes).filter(v => v.includes(suffix));
            if (classNames.length) {
                hits.push({ id: modId, hint: u.getModuleHint(modId), classNames: classNames.slice(0, 5) });
                if (hits.length >= limit) break;
            }
        }
        if (hits.length) return { landmark, type: "cssClass", suffix, classMapModules: hits };
    }

    if (/Store$/.test(landmark)) {
        const resolved = resolveStore(landmark);
        if (resolved) {
            const defining = u.findModuleIds(src => src.includes(`displayName:"${resolved.name}"`), limit);
            const referencing = defining.length ? [] : u.findModuleIds(src => src.includes(`"${resolved.name}"`), limit);
            return { landmark, type: "store", store: resolved.name, definingModules: decorate(defining), referencingModules: referencing.length ? decorate(referencing) : undefined };
        }
    }

    if (/^[A-Z][A-Z0-9_]+$/.test(landmark)) {
        const result: Record<string, unknown> = { landmark, type: "symbol" };
        let hit = false;
        const hash = u.runtimeHashMessageKey(landmark);
        const intlModules = u.findModuleIds(src => src.includes(`.t.${hash}`) || src.includes(`.t["${hash}"]`), 5);
        if (intlModules.length) { result.asIntlKey = { hash, modules: decorate(intlModules) }; hit = true; }
        const producers = u.findModuleIds(src => src.includes(`type:"${landmark}"`), 5);
        if (producers.length) { result.asActionType = { producers: decorate(producers) }; hit = true; }
        const enumMods = findAll(m => !!m && typeof m === "object" && u.safeCall(() => (m as Record<string, unknown>)[landmark] !== undefined, false));
        if (enumMods.length) { result.asEnumKey = { enumObjectCount: enumMods.length }; hit = true; }
        if (hit) return result;
    }

    const modules = u.findModuleIds(src => src.includes(landmark), limit);
    return { landmark, type: "literal", moduleCount: modules.length, modules: decorate(modules) };
}
