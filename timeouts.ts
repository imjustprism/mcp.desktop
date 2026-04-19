/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_TIMEOUT_MS = 30_000;

export const TIMEOUT_MS: Readonly<Record<string, number>> = {
    "intl:bruteforce": 600_000,
    "intl:test": 120_000,
    "intl:unknown": 60_000,
    "module:loadLazy": 120_000,
    "module:watch": 120_000,
    "module:watchGet": 60_000,
    "module:components": 120_000,
    "module:findFactory": 60_000,
    "module:patchedList": 60_000,
    "module:whereUsed": 60_000,
    "trace:start": 120_000,
    "trace:store": 120_000,
    "intercept:set": 120_000,
    "patch:benchmark": 60_000,
    "patch:slowscan": 60_000,
    "patch:analyze": 60_000,
    "patch:finds": 60_000,
    "discord:waitForIpc": 30_000,
    search: 60_000,
};

export function getToolTimeout(toolName: string, action?: string): number {
    if (action) return TIMEOUT_MS[`${toolName}:${action}`] ?? DEFAULT_TIMEOUT_MS;
    return TIMEOUT_MS[toolName] ?? DEFAULT_TIMEOUT_MS;
}
