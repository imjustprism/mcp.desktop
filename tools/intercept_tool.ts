/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FunctionIntercept, InterceptCapture, InterceptToolArgs, ToolResult } from "../types";
import { LIMITS } from "./constants";
import * as u from "./utils";

function summarizeIntercept(captures: InterceptCapture[], limit: number) {
    const sliced = captures.slice(0, limit).map(c => {
        const summary: Record<string, unknown> = { ts: c.ts };
        if (c.args.length) summary.args = u.serializeResult(c.args, LIMITS.INTERCEPT.SUMMARIZE_ARGS);
        if (c.result !== undefined) summary.result = u.serializeResult(c.result, LIMITS.INTERCEPT.SUMMARIZE_RESULT);
        if (c.error) summary.error = c.error;
        return summary;
    });
    return { captures: sliced, truncated: captures.length > limit ? true : undefined };
}

function interceptMeta(i: FunctionIntercept) {
    return { id: i.id, moduleId: i.moduleId, exportKey: i.exportKey, captureCount: i.captures.length, remaining: u.remainingMs(i.expiresAt), ended: i.endedAt ? true : undefined };
}

export async function handleIntercept(args: InterceptToolArgs): Promise<ToolResult> {
    const { action, id: interceptId, moduleId } = args;
    const exportKey = args.exportKey ?? "default";
    const duration = u.clamp(args.duration, LIMITS.INTERCEPT.DURATION_DEFAULT_MS, LIMITS.INTERCEPT.DURATION_MIN_MS, LIMITS.INTERCEPT.DURATION_MAX_MS);
    const maxCaptures = Math.min(args.maxCaptures ?? LIMITS.INTERCEPT.MAX_CAPTURES_DEFAULT, LIMITS.INTERCEPT.MAX_CAPTURES_CAP);

    u.cleanupExpiredIntercepts();

    if (action === "set" && moduleId) {
        const mod = u.moduleAt(moduleId);
        if (!mod?.exports) return u.moduleNotFound(moduleId);

        let target: unknown;
        let actualKey = exportKey;
        let methodKey: string | undefined;
        let methodParent: Record<string, unknown> | undefined;

        if (exportKey === "default" && mod.exports.default) {
            target = mod.exports.default;
        } else if (exportKey === "module") {
            target = mod.exports;
            actualKey = "module";
        } else if (exportKey.includes(".")) {
            const [parentKey, method] = exportKey.split(".", 2);
            const parent = parentKey === "default" ? mod.exports.default : mod.exports[parentKey];
            if (!parent || typeof parent !== "object") {
                return { error: true, message: `"${parentKey}" is not an object` };
            }
            methodParent = parent as Record<string, unknown>;
            target = methodParent[method];
            if (typeof target !== "function") {
                return { error: true, message: `"${parentKey}.${method}" is not a function`, availableMethods: u.collectMethods(parent, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS) };
            }
            methodKey = method;
        } else {
            target = mod.exports[exportKey];
        }

        if (typeof target !== "function") {
            const available = Object.keys(mod.exports)
                .filter(k => typeof mod.exports[k] === "function")
                .slice(0, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS);

            const methods = u.collectMethods(target, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS);
            const exportObjects = Object.keys(mod.exports)
                .map(k => ({ key: k, val: mod.exports[k], methods: u.collectMethods(mod.exports[k]) }))
                .filter(e => e.methods.length > 0)
                .slice(0, LIMITS.INTERCEPT.EXPORT_OBJECTS_SLICE)
                .map(e => ({ key: e.key, displayName: (e.val as { displayName?: string })?.displayName, methodCount: e.methods.length }));

            return {
                error: true,
                message: `"${exportKey}" is not a function`,
                availableFunctions: available,
                availableMethods: methods.length ? methods : undefined,
                exportObjects: exportObjects.length ? exportObjects : undefined,
                tip: methods.length
                    ? `Use "${exportKey}.methodName" for method interception`
                    : exportObjects.length
                      ? `Try "${exportObjects[0].key}.methodName" (${exportObjects[0].displayName ?? "object"} with ${exportObjects[0].methodCount} methods)`
                      : undefined,
            };
        }

        const id = u.interceptState.nextId++;
        const intercept: FunctionIntercept = {
            id,
            moduleId,
            exportKey: actualKey,
            methodKey,
            methodParent,
            original: target as (...args: unknown[]) => unknown,
            captures: [],
            maxCaptures,
            expiresAt: Date.now() + duration,
        };

        const wrapper = function (this: unknown, ...fnArgs: unknown[]) {
            if (Date.now() >= intercept.expiresAt) {
                u.endIntercept(id);
            } else if (intercept.captures.length < intercept.maxCaptures) {
                const capture: InterceptCapture = { ts: Date.now(), args: fnArgs };
                try {
                    const res = intercept.original.apply(this, fnArgs);
                    capture.result = res;
                    intercept.captures.push(capture);
                    return res;
                } catch (e) {
                    capture.error = u.errMsg(e);
                    intercept.captures.push(capture);
                    throw e;
                }
            }
            return intercept.original.apply(this, fnArgs);
        };

        try {
            if (methodKey && methodParent) {
                methodParent[methodKey] = wrapper;
            } else if (actualKey === "module") {
                Object.defineProperty(mod, "exports", { value: Object.assign(wrapper, target), configurable: true, writable: true });
            } else {
                Object.defineProperty(mod.exports, actualKey, { value: wrapper, configurable: true, writable: true });
            }
        } catch {
            u.mcpLogger.warn(`intercept: ${moduleId}.${actualKey} not configurable`);
            return { error: true, message: `${moduleId}.${actualKey} not configurable` };
        }

        u.interceptState.active.set(id, intercept);
        u.invalidateIdentityIndex();
        return { id, moduleId, exportKey: actualKey, duration, maxCaptures };
    }

    if (action === "get") {
        if (interceptId === undefined) {
            const intercepts = [...u.interceptState.active.values()].map(interceptMeta);
            return { activeIntercepts: intercepts.length, intercepts };
        }

        const intercept = u.interceptState.active.get(interceptId);
        if (!intercept) return { error: true, message: `Intercept ${interceptId} not found` };

        const summary = summarizeIntercept(intercept.captures, LIMITS.INTERCEPT.GET_CAPTURE_SLICE);
        return { ...interceptMeta(intercept), ...summary };
    }

    if (action === "stop") {
        if (interceptId === undefined) return u.stopAllResult(u.interceptState.active, u.cleanupAllIntercepts);
        const wasEnded = u.interceptState.active.get(interceptId)?.endedAt !== undefined;
        const result = u.stopOneResult(u.interceptState.active, interceptId, "Intercept", u.cleanupIntercept, c => summarizeIntercept(c, LIMITS.INTERCEPT.STOP_CAPTURE_SLICE));
        return wasEnded && !("error" in result) ? { ...result, ended: true } : result;
    }

    return { error: true, message: "action: set, get, stop" };
}
