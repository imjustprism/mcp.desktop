/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, RestAPI, SelectedChannelStore, SelectedGuildStore, UserStore } from "@webpack/common";

import { DiscordAPIError, DiscordToolArgs, ToolResult } from "../types";
import { DesignTokensModule, DiscordConstants, Endpoints, ExperimentStore, findAll, GatewayConnectionStore, getCommonModules, getSnowflakeUtils, IconUtilsModule, PlatformUtilsModule } from "../webpack";
import { LIMITS } from "./constants";
import { serializeResult } from "./utils";

export async function handleDiscordTool(args: DiscordToolArgs): Promise<ToolResult> {
    const { action, method, endpoint, body, id, filter: filterPattern, memberName } = args;

    if (action === "api") {
        if (!method || !endpoint) return { error: true, message: "method and endpoint required" };

        const apiCall = RestAPI[method];
        if (!apiCall) return { error: true, message: `Invalid method: ${method}` };

        try {
            const response = await apiCall({ url: endpoint, body });
            const respBody = typeof response.body === "object" && response.body !== null
                ? serializeResult(response.body, LIMITS.DISCORD.API_SERIALIZE)
                : response.body;
            return { status: response.status, body: respBody };
        } catch (e) {
            const err = e as DiscordAPIError;
            return { error: true, status: err.status ?? err.httpStatus, message: err.body?.message ?? err.message ?? String(e) };
        }
    }

    if (action === "snowflake") {
        if (!id) return { error: true, message: "id required" };

        try {
            const utils = getSnowflakeUtils();
            const timestamp = utils.extractTimestamp(id);
            const date = new Date(timestamp);
            return {
                id,
                valid: utils.isProbablyAValidSnowflake(id),
                timestamp,
                date: date.toISOString(),
                unix: Math.floor(timestamp / 1000),
                age: `${Math.floor((Date.now() - timestamp) / 86400000)} days ago`,
                workerId: Number((BigInt(id) & 0x3E0000n) >> 17n),
                processId: Number((BigInt(id) & 0x1F000n) >> 12n),
                increment: Number(BigInt(id) & 0xFFFn)
            };
        } catch {
            return { error: true, message: "Invalid snowflake ID" };
        }
    }

    if (action === "endpoints") {
        if (!Endpoints) return { error: true, message: "Endpoints not found" };
        const endpoints = Endpoints;

        let entries = Object.entries(endpoints);
        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            entries = entries.filter(([k]) => k.toLowerCase().includes(lower));
        }

        const maxEndpoints = filterPattern ? LIMITS.DISCORD.ENDPOINTS_FILTERED : LIMITS.DISCORD.ENDPOINTS_DEFAULT;
        return {
            found: true,
            count: entries.length,
            endpoints: Object.fromEntries(entries.slice(0, maxEndpoints).map(([k, v]) => [k, typeof v === "function" ? (v as (id1: string, id2: string) => string)("ID1", "ID2").slice(0, LIMITS.DISCORD.ENDPOINT_VALUE_SLICE) : v])),
            note: entries.length > maxEndpoints ? "Use filter to narrow" : undefined
        };
    }

    if (action === "common") {
        const common = getCommonModules();

        let keys = Object.keys(common);
        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            keys = keys.filter(k => k.toLowerCase().includes(lower));
        }

        return {
            count: keys.length,
            modules: keys.sort().slice(0, LIMITS.DISCORD.COMMON_MODULES_SLICE).map(k => ({ name: k, type: typeof common[k] })),
            note: keys.length > LIMITS.DISCORD.COMMON_MODULES_SLICE ? "Use filter to narrow" : undefined
        };
    }

    if (action === "enum") {
        if (!memberName) return { error: true, message: "memberName required" };

        const mods = findAll(m => {
            if (!m || typeof m !== "object") return false;
            const val = (m as Record<string, unknown>)[memberName];
            return val !== undefined && (typeof val === "number" || typeof val === "string");
        });

        return {
            count: mods.length,
            matches: mods.slice(0, LIMITS.DISCORD.ENUM_MATCHES).map(mod => {
                const keys = Object.keys(mod as object).filter(k => typeof (mod as Record<string, unknown>)[k] === "number" || typeof (mod as Record<string, unknown>)[k] === "string");
                return { keys: keys.slice(0, LIMITS.DISCORD.ENUM_KEYS), sample: Object.fromEntries(keys.slice(0, LIMITS.DISCORD.ENUM_SAMPLE).map(k => [k, (mod as Record<string, unknown>)[k]])) };
            })
        };
    }

    if (action === "memory") {
        const { memory } = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
        if (!memory) return { error: true, message: "Memory API not available" };

        return {
            usedJSHeapSize: memory.usedJSHeapSize,
            usedJSHeapSizeMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
            totalJSHeapSize: memory.totalJSHeapSize,
            totalJSHeapSizeMB: Math.round(memory.totalJSHeapSize / 1024 / 1024),
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
            jsHeapSizeLimitMB: Math.round(memory.jsHeapSizeLimit / 1024 / 1024),
            usagePercent: Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100)
        };
    }

    if (action === "performance") {
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;

        const pageLoad = navigation ? Math.round(navigation.loadEventEnd - navigation.startTime) : null;
        const domReady = navigation ? Math.round(navigation.domContentLoadedEventEnd - navigation.startTime) : null;

        const resourceStats = {
            total: resources.length,
            byType: {} as Record<string, number>,
            totalSize: 0,
            slowest: [] as Array<{ name: string; duration: number }>
        };

        for (const r of resources) {
            const ext = r.name.split(".").pop()?.split("?")[0] ?? "unknown";
            resourceStats.byType[ext] = (resourceStats.byType[ext] ?? 0) + 1;
            resourceStats.totalSize += r.transferSize ?? 0;
        }

        resourceStats.slowest = resources
            .sort((a, b) => b.duration - a.duration)
            .slice(0, LIMITS.DISCORD.SLOWEST_RESOURCES)
            .map(r => ({ name: r.name.split("/").pop()?.slice(0, LIMITS.DISCORD.RESOURCE_NAME_SLICE) ?? "", duration: Math.round(r.duration) }));

        return { pageLoadMs: pageLoad, domReadyMs: domReady, resources: resourceStats, now: Math.round(performance.now()) };
    }

    if (action === "waitForIpc") {
        const timeout = args.timeout ?? 10000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (UserStore.getCurrentUser()) return { ready: true, elapsed: Date.now() - start };
            await new Promise(r => setTimeout(r, LIMITS.DISCORD.WAITFORIPC_POLL_MS));
        }
        return { ready: false, elapsed: Date.now() - start, message: "Timed out" };
    }

    if (action === "gateway") {
        if (!GatewayConnectionStore) return { error: true, message: "GatewayConnectionStore not found" };

        const socket = GatewayConnectionStore.getSocket();
        if (!socket) return { connected: false, message: "No active gateway connection" };

        const now = Date.now();
        return {
            connected: GatewayConnectionStore.isConnected(),
            state: socket.connectionState_,
            sessionId: socket.sessionId ? `${socket.sessionId.slice(0, LIMITS.DISCORD.SESSION_ID_SLICE)}...` : null,
            sequence: socket.seq,
            heartbeat: {
                interval: socket.heartbeatInterval,
                lastAck: socket.heartbeatAck,
                latency: socket.lastHeartbeatAckTime && socket.lastHeartbeatTime ? socket.lastHeartbeatAckTime - socket.lastHeartbeatTime : null
            },
            uptime: socket.connectionStartTime ? Math.round((now - socket.connectionStartTime) / 1000) : null,
            identifyCount: socket.identifyCount,
            resumeUrl: socket.resumeUrl
        };
    }

    if (action === "constants") {
        if (!DiscordConstants) return { error: true, message: "Constants not found" };

        const categories = Object.keys(DiscordConstants);

        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            const matching = categories.filter(k => k.toLowerCase().includes(lower));

            if (!matching.length) return { count: 0, categories: [], message: `No constant categories matching "${filterPattern}"` };

            const results: Record<string, unknown> = {};
            for (const key of matching.slice(0, LIMITS.DISCORD.ENDPOINTS_FILTERED)) {
                const val = DiscordConstants[key];
                if (val && typeof val === "object") {
                    const entries = Object.entries(val as Record<string, unknown>);
                    results[key] = {
                        type: typeof val,
                        keyCount: entries.length,
                        sample: Object.fromEntries(entries.slice(0, 20).map(([k, v]) => [k, typeof v === "function" ? "(function)" : v]))
                    };
                } else {
                    results[key] = val;
                }
            }
            return { count: matching.length, entries: results };
        }

        const summary: Record<string, { type: string; keyCount?: number }> = {};
        for (const key of categories) {
            const val = DiscordConstants[key];
            summary[key] = {
                type: typeof val,
                keyCount: val && typeof val === "object" ? Object.keys(val as object).length : undefined
            };
        }
        return { count: categories.length, categories: summary };
    }

    if (action === "experiments") {
        if (!ExperimentStore) return { error: true, message: "ExperimentStore not found" };

        const store = ExperimentStore as Record<string, (...args: unknown[]) => unknown>;

        if (filterPattern) {
            try {
                const all = store.getRegisteredExperiments?.() as Record<string, unknown> | undefined;
                if (all) {
                    const lower = filterPattern.toLowerCase();
                    const matches: Array<{ name: string; type: string }> = [];
                    for (const [name, exp] of Object.entries(all)) {
                        if (name.toLowerCase().includes(lower) && matches.length < LIMITS.DISCORD.EXPERIMENT_SLICE) {
                            matches.push({ name, type: typeof exp });
                        }
                    }
                    return { count: matches.length, experiments: matches };
                }
            } catch { return { error: true, message: "Failed to query experiments" }; }
        }

        try {
            const registered = store.getRegisteredExperiments?.() as Record<string, unknown> | undefined;
            const overrides = store.getAllExperimentOverrideDescriptors?.() as Record<string, unknown> | undefined;
            const assignments = store.getAllExperimentAssignments?.() as Record<string, unknown> | undefined;

            return {
                registeredCount: registered ? Object.keys(registered).length : 0,
                overrideCount: overrides ? Object.keys(overrides).length : 0,
                assignmentCount: assignments ? Object.keys(assignments).length : 0,
                sampleRegistered: registered ? Object.keys(registered).slice(0, LIMITS.DISCORD.EXPERIMENT_SLICE) : undefined,
                sampleOverrides: overrides ? Object.keys(overrides).slice(0, 10) : undefined,
            };
        } catch (e) {
            return { error: true, message: `ExperimentStore error: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    if (action === "platform") {
        if (!PlatformUtilsModule) return { error: true, message: "PlatformUtils not found" };

        const p = PlatformUtilsModule;
        const env = (window as unknown as Record<string, unknown>).GLOBAL_ENV as Record<string, unknown> | undefined;

        const safeBoolCall = (fn: unknown) => { try { return (fn as () => boolean)(); } catch { return null; } };

        return {
            platform: p.getPlatform(),
            platformName: p.getPlatformName(),
            os: p.getOS(),
            isDesktop: safeBoolCall(p.isDesktop),
            isWeb: safeBoolCall(p.isWeb),
            isWindows: safeBoolCall(p.isWindows),
            isLinux: safeBoolCall(p.isLinux),
            isMac: safeBoolCall(p.isMac),
            isPlatformEmbedded: safeBoolCall(p.isPlatformEmbedded),
            env: env ? {
                releaseChannel: env.RELEASE_CHANNEL,
                buildNumber: env.BUILD_NUMBER,
                versionHash: (env.VERSION_HASH as string)?.slice(0, 16),
                apiEndpoint: env.API_ENDPOINT,
                gatewayEndpoint: env.GATEWAY_ENDPOINT,
                cdnHost: env.CDN_HOST,
            } : undefined
        };
    }

    if (action === "tokens") {
        if (!DesignTokensModule) return { error: true, message: "Design tokens not found" };

        const t = DesignTokensModule;
        const colorKeys = Object.keys(t.colors ?? {});
        const rawColorKeys = Object.keys(t.unsafe_rawColors ?? {});

        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            const matchingColors = colorKeys.filter(k => k.toLowerCase().includes(lower));
            const colorDetails = matchingColors.slice(0, LIMITS.DISCORD.TOKEN_COLOR_SLICE).map(k => ({
                name: k,
                cssVar: t.colors[k]?.css,
            }));
            return { query: filterPattern, colorCount: matchingColors.length, colors: colorDetails };
        }

        const themes = Object.keys(t.themes ?? {});
        const shadows = Object.keys(t.shadows ?? {});
        const themeEnum = Object.fromEntries(Object.entries(t.themes ?? {}).filter(([, v]) => typeof v === "string"));

        return {
            semanticColors: colorKeys.length,
            rawColors: rawColorKeys.length,
            themes,
            themeEnum,
            shadows: shadows.slice(0, 15),
            radii: t.radii,
            spacing: t.spacing,
            modules: t.modules ? Object.keys(t.modules) : undefined,
            sampleColors: colorKeys.slice(0, LIMITS.DISCORD.TOKEN_COLOR_SLICE).map(k => ({ name: k, css: t.colors[k]?.css })),
            tip: "Use filter to search colors by name"
        };
    }

    if (action === "icons") {
        if (!IconUtilsModule) return { error: true, message: "IconUtils not found" };

        const functions = Object.keys(IconUtilsModule)
            .filter(k => typeof IconUtilsModule[k] === "function")
            .slice(0, LIMITS.DISCORD.ICON_UTIL_FUNCTIONS);

        return {
            functionCount: functions.length,
            functions,
            tip: "Use evaluateCode to call functions, e.g. IconUtils.getUserAvatarURL(user)"
        };
    }

    const currentUser = UserStore.getCurrentUser();
    const selectedChannelId = SelectedChannelStore.getChannelId();
    const selectedGuildId = SelectedGuildStore.getGuildId();
    const channel = selectedChannelId ? ChannelStore.getChannel(selectedChannelId) : null;
    const guild = selectedGuildId ? GuildStore.getGuild(selectedGuildId) : null;

    return {
        user: currentUser ? { id: currentUser.id, username: currentUser.username, discriminator: currentUser.discriminator } : null,
        channel: channel ? { id: channel.id, name: channel.name, type: channel.type } : null,
        guild: guild ? { id: guild.id, name: guild.name, ownerId: guild.ownerId } : null
    };
}
