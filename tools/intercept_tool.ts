/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { wreq } from "@webpack";

import { FunctionIntercept, InterceptCapture, WebpackModule } from "../types";
import { cleanupAllIntercepts, cleanupExpiredIntercepts, cleanupIntercept, interceptState } from "./utils";

export async function handleInterceptTool(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action as string | undefined;
    const interceptId = args.id as number | undefined;
    const moduleId = args.moduleId as string | undefined;
    const exportKey = args.exportKey as string ?? "default";
    const duration = Math.min(Math.max(args.duration as number ?? 30000, 5000), 120000);
    const maxCaptures = Math.min(args.maxCaptures as number ?? 50, 200);

    cleanupExpiredIntercepts();

    if (action === "set" && moduleId) {
        const mod = wreq.c[moduleId] as WebpackModule | undefined;
        if (!mod?.exports) return { error: true, message: `Module ${moduleId} not found or not loaded` };

        let target: unknown;
        let actualKey = exportKey;

        if (exportKey === "default" && mod.exports.default) {
            target = mod.exports.default;
        } else if (exportKey === "module") {
            target = mod.exports;
            actualKey = "module";
        } else {
            target = mod.exports[exportKey];
        }

        if (typeof target !== "function") {
            const available = Object.keys(mod.exports).filter(k => typeof mod.exports[k] === "function").slice(0, 20);
            return { error: true, message: `Export "${exportKey}" is not a function (type: ${typeof target})`, availableFunctions: available };
        }

        const id = interceptState.nextId++;
        const intercept: FunctionIntercept = {
            id,
            moduleId,
            exportKey: actualKey,
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
            if (actualKey === "module") {
                Object.defineProperty(wreq.c, moduleId, { value: { exports: wrapper }, configurable: true, writable: true });
            } else {
                Object.defineProperty(mod.exports, actualKey, { value: wrapper, configurable: true, writable: true });
            }
        } catch {
            return { error: true, message: `Cannot override ${moduleId}.${actualKey}, property not configurable` };
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

        const truncated = intercept.captures.length > 30;
        return {
            id: interceptId,
            moduleId: intercept.moduleId,
            exportKey: intercept.exportKey,
            captureCount: intercept.captures.length,
            remaining: Math.max(0, intercept.expiresAt - Date.now()),
            captures: intercept.captures.slice(0, 30),
            truncated: truncated || undefined
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
        return { id: interceptId, stopped: true, captureCount: captures.length, captures: captures.slice(0, 50) };
    }

    return { error: true, message: "action: set (with moduleId, exportKey), get (with optional id), stop (with optional id)" };
}
