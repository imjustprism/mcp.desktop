/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FunctionIntercept, InterceptCapture, InterceptToolArgs, WebpackModule } from "../types";
import { wreq } from "../webpack";
import { LIMITS } from "./constants";
import { cleanupAllIntercepts, cleanupExpiredIntercepts, cleanupIntercept, collectMethods, interceptState, serializeResult } from "./utils";

function summarizeIntercept(captures: InterceptCapture[], limit: number) {
    const sliced = captures.slice(0, limit).map(c => {
        const summary: Record<string, unknown> = { ts: c.ts };
        if (c.args.length) summary.args = serializeResult(c.args, LIMITS.INTERCEPT.SUMMARIZE_ARGS);
        if (c.result !== undefined) summary.result = serializeResult(c.result, LIMITS.INTERCEPT.SUMMARIZE_RESULT);
        if (c.error) summary.error = c.error;
        return summary;
    });
    return { captures: sliced, truncated: captures.length > limit ? true : undefined };
}

export async function handleInterceptTool(args: InterceptToolArgs): Promise<unknown> {
    const { action, id: interceptId, moduleId } = args;
    const exportKey = args.exportKey ?? "default";
    const duration = Math.min(Math.max(args.duration ?? 30000, 5000), 120000);
    const maxCaptures = Math.min(args.maxCaptures ?? 50, 200);

    cleanupExpiredIntercepts();

    if (action === "set" && moduleId) {
        const mod = wreq.c[moduleId] as WebpackModule | undefined;
        if (!mod?.exports) return { error: true, message: `Module ${moduleId} not found` };

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
            target = (parent as Record<string, unknown>)[method];
            if (typeof target !== "function") {
                return { error: true, message: `"${parentKey}.${method}" is not a function`, availableMethods: collectMethods(parent, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS) };
            }
            methodKey = method;
            methodParent = parent as Record<string, unknown>;
            actualKey = exportKey;
        } else {
            target = mod.exports[exportKey];
        }

        if (typeof target !== "function") {
            const available = Object.keys(mod.exports).filter(k => typeof mod.exports[k] === "function").slice(0, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS);

            const methods = collectMethods(target, LIMITS.INTERCEPT.AVAILABLE_FUNCTIONS);
            const exportObjects = Object.keys(mod.exports)
                .filter(k => typeof mod.exports[k] === "object" && mod.exports[k] && collectMethods(mod.exports[k]).length > 0)
                .slice(0, 5)
                .map(k => ({ key: k, displayName: (mod.exports[k] as { displayName?: string })?.displayName, methodCount: collectMethods(mod.exports[k]).length }));

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
                        : undefined
            };
        }

        const id = interceptState.nextId++;
        const intercept: FunctionIntercept = {
            id,
            moduleId,
            exportKey: actualKey,
            methodKey,
            methodParent,
            original: target as (...args: unknown[]) => unknown,
            captures: [],
            maxCaptures,
            expiresAt: Date.now() + duration
        };

        const wrapper = function (this: unknown, ...fnArgs: unknown[]) {
            const capture: InterceptCapture = { ts: Date.now(), args: fnArgs };

            if (intercept.captures.length < intercept.maxCaptures) {
                try {
                    const res = intercept.original.apply(this, fnArgs);
                    capture.result = res;
                    intercept.captures.push(capture);
                    return res;
                } catch (e) {
                    capture.error = e instanceof Error ? e.message : String(e);
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
                const originalMod = wreq.c[moduleId];
                Object.defineProperty(originalMod, "exports", { value: Object.assign(wrapper, target as object), configurable: true, writable: true });
            } else {
                Object.defineProperty(mod.exports, actualKey, { value: wrapper, configurable: true, writable: true });
            }
        } catch {
            return { error: true, message: `${moduleId}.${actualKey} not configurable` };
        }

        interceptState.active.set(id, intercept);
        return { id, moduleId, exportKey: actualKey, duration, maxCaptures };
    }

    if (action === "get") {
        if (interceptId === undefined) {
            const intercepts = [...interceptState.active.values()].map(i => ({
                id: i.id,
                moduleId: i.moduleId,
                exportKey: i.exportKey,
                captureCount: i.captures.length,
                remaining: Math.max(0, i.expiresAt - Date.now())
            }));
            return { activeIntercepts: intercepts.length, intercepts };
        }

        const intercept = interceptState.active.get(interceptId);
        if (!intercept) return { error: true, message: `Intercept ${interceptId} not found or expired` };

        const summary = summarizeIntercept(intercept.captures, LIMITS.INTERCEPT.GET_CAPTURE_SLICE);
        return {
            id: interceptId,
            moduleId: intercept.moduleId,
            exportKey: intercept.exportKey,
            captureCount: intercept.captures.length,
            remaining: Math.max(0, intercept.expiresAt - Date.now()),
            ...summary
        };
    }

    if (action === "stop") {
        if (interceptId === undefined) {
            const count = interceptState.active.size;
            cleanupAllIntercepts();
            return { stopped: count };
        }

        const intercept = interceptState.active.get(interceptId);
        if (!intercept) return { error: true, message: `Intercept ${interceptId} not found` };

        const { captures } = intercept;
        cleanupIntercept(interceptId);
        const summary = summarizeIntercept(captures, LIMITS.INTERCEPT.STOP_CAPTURE_SLICE);
        return { id: interceptId, stopped: true, captureCount: captures.length, ...summary };
    }

    return { error: true, message: "action: set, get, stop" };
}
