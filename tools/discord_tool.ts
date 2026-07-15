/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { ChannelStore, GuildStore, RestAPI, SelectedChannelStore, SelectedGuildStore, UserStore } from "@webpack/common";

import { DiscordAPIError, DiscordToolArgs, ToolResult } from "../types";
import { DesignTokensModule, DiscordConstants, Endpoints, findAll, findStore, getCommonModules, getSnowflakeUtils, plugins, wreq } from "../webpack";
import { recentConsole } from "./console_tool";
import { LIMITS } from "./constants";
import * as u from "./utils";

const Native = VencordNative.pluginHelpers.mcp as PluginNative<typeof import("../native")>;

function readBuildInfo() {
    const env = (window as unknown as { GLOBAL_ENV?: Record<string, unknown> }).GLOBAL_ENV ?? {};
    const native = (window as unknown as { DiscordNative?: { app?: { getVersion?: () => string; getReleaseChannel?: () => string } } }).DiscordNative;
    const sentryTags = env.SENTRY_TAGS as { buildId?: string; buildType?: string } | undefined;
    return {
        releaseChannel: env.RELEASE_CHANNEL ?? u.safeCall(() => native?.app?.getReleaseChannel?.() ?? null, null),
        buildId: sentryTags?.buildId ?? null,
        buildType: sentryTags?.buildType ?? null,
        versionHash: env.VERSION_HASH ?? null,
        apiVersion: env.API_VERSION ?? null,
        apiEndpoint: env.API_ENDPOINT ?? null,
        hostVersion: u.safeCall(() => native?.app?.getVersion?.() ?? null, null),
        modVersion: VERSION,
        userAgent: navigator.userAgent.slice(0, 160),
    };
}

export async function handleDiscord(args: DiscordToolArgs): Promise<ToolResult> {
    const { action, method, endpoint, body, id, filter: filterPattern, memberName } = args;

    if (action === "api") {
        if (!method || !endpoint) return { error: true, message: "method and endpoint required" };

        const apiCall = RestAPI[method];
        if (!apiCall) return { error: true, message: `Invalid method: ${method}` };

        try {
            const response = await apiCall({ url: endpoint, body });
            const respBody = typeof response.body === "object" && response.body !== null ? u.serializeResult(response.body, LIMITS.DISCORD.API_SERIALIZE) : response.body;
            return { status: response.status, body: respBody };
        } catch (e) {
            const err = e as DiscordAPIError;
            const msg = err.body?.message ?? err.message ?? String(e);
            u.mcpLogger.error(`discord api ${method} ${endpoint}: ${msg}`);
            return { error: true, status: err.status ?? err.httpStatus, message: msg };
        }
    }

    if (action === "buildInfo") return readBuildInfo();

    if (action === "orient") {
        const ready = !!UserStore.getCurrentUser();
        const build = readBuildInfo();

        let serverRunning = true;
        let port = 0;
        try {
            const status = await Native.getServerStatus();
            serverRunning = status.running;
            port = status.port;
        } catch {
            serverRunning = false;
        }

        const pluginNames = Object.keys(plugins);
        const enabledPlugins = pluginNames.filter(n => plugins[n]?.started).length;

        return {
            ready,
            runtime: { serverRunning, port },
            counts: {
                modules: u.getModuleIds().length,
                loadedModules: Object.keys(wreq.c).length,
                stores: u.getAllStoreNames().length,
                plugins: pluginNames.length,
            },
            build: { releaseChannel: build.releaseChannel, versionHash: build.versionHash, modVersion: build.modVersion },
            consoleErrors: recentConsole("error").length,
            plugins: { total: pluginNames.length, enabled: enabledPlugins },
            next: ready
                ? { tool: "resolve", action: null, reason: "resolve a landmark (intl hash, CSS class, StoreName, SCREAMING_SNAKE) to its owning module" }
                : { tool: "reloadDiscord", action: null, reason: "client not hydrated yet, reload then retry" },
        };
    }

    if (action === "experiments") {
        const store = findStore("ExperimentStore") as Record<string, unknown> | null;
        if (!store) return { error: true, message: "ExperimentStore not found" };
        const getRegistered = store.getRegisteredExperiments as (() => Record<string, Record<string, unknown>>) | undefined;
        const descriptors = u.safeCall(() => getRegistered?.() ?? {}, {} as Record<string, Record<string, unknown>>);
        let entries = Object.entries(descriptors);
        if (filterPattern) {
            const q = filterPattern.toLowerCase();
            entries = entries.filter(([k, v]) => k.toLowerCase().includes(q) || String(v?.title ?? v?.label ?? "").toLowerCase().includes(q));
        }
        return {
            count: entries.length,
            scope: "experiments registered by modules loaded this session, not the full catalog",
            experiments: entries.slice(0, LIMITS.DISCORD.ENUM_MATCHES * 4).map(([k, v]) => ({
                id: k,
                type: typeof v?.type === "string" ? v.type : undefined,
                label: String(v?.title ?? v?.label ?? "").slice(0, 80) || undefined,
                buckets: Array.isArray(v?.buckets) ? (v.buckets as unknown[]).length : undefined,
            })),
            note: entries.length > LIMITS.DISCORD.ENUM_MATCHES * 4 ? "Use filter to narrow" : undefined,
        };
    }

    if (action === "snowflake") {
        if (!id) return u.missingArg("id");

        try {
            const utils = getSnowflakeUtils();
            const timestamp = utils.extractTimestamp(id);
            return {
                id,
                valid: utils.isProbablyAValidSnowflake(id),
                timestamp,
                date: new Date(timestamp).toISOString(),
                unix: Math.floor(timestamp / 1000),
            };
        } catch {
            return { error: true, message: "Invalid snowflake ID" };
        }
    }

    if (action === "endpoints") {
        if (!Endpoints) return { error: true, message: "Endpoints not found" };

        let entries = Object.entries(Endpoints);
        if (filterPattern) entries = u.filterBySubstring(entries, filterPattern, ([k]) => k);

        const maxEndpoints = filterPattern ? LIMITS.DISCORD.ENDPOINTS_FILTERED : LIMITS.DISCORD.ENDPOINTS_DEFAULT;
        return {
            found: true,
            count: entries.length,
            endpoints: Object.fromEntries(
                entries
                    .slice(0, maxEndpoints)
                    .map(([k, v]) => {
                        if (typeof v !== "function") return [k, v];
                        try { return [k, v("ID1", "ID2").slice(0, LIMITS.DISCORD.ENDPOINT_VALUE_SLICE)]; }
                        catch { return [k, "(function)"]; }
                    }),
            ),
            note: entries.length > maxEndpoints ? "Use filter to narrow" : undefined,
        };
    }

    if (action === "common") {
        const common = getCommonModules();

        let keys = Object.keys(common);
        if (filterPattern) keys = u.filterBySubstring(keys, filterPattern, k => k);

        return {
            count: keys.length,
            modules: keys
                .sort()
                .slice(0, LIMITS.DISCORD.COMMON_MODULES_SLICE)
                .map(k => ({ name: k, type: typeof common[k] })),
            note: keys.length > LIMITS.DISCORD.COMMON_MODULES_SLICE ? "Use filter to narrow" : undefined,
        };
    }

    if (action === "enum") {
        if (!memberName) return u.missingArg("memberName");

        const lowerFilter = filterPattern?.toLowerCase();
        const mods = findAll(m => {
            if (!m || typeof m !== "object") return false;
            const rec = m as Record<string, unknown>;
            const val = rec[memberName];
            if (val === undefined || (typeof val !== "number" && typeof val !== "string")) return false;
            return !lowerFilter || Object.keys(rec).some(k => k.toLowerCase().includes(lowerFilter));
        });

        return {
            count: mods.length,
            matches: mods.slice(0, LIMITS.DISCORD.ENUM_MATCHES).map(mod => {
                const rec = mod as Record<string, unknown>;
                const keys = Object.keys(rec).filter(k => typeof rec[k] === "number" || typeof rec[k] === "string");
                return { keys: keys.slice(0, LIMITS.DISCORD.ENUM_KEYS), sample: Object.fromEntries(keys.slice(0, LIMITS.DISCORD.ENUM_SAMPLE).map(k => [k, rec[k]])) };
            }),
        };
    }

    if (action === "constants") {
        if (!DiscordConstants) return { error: true, message: "Constants not found" };

        const categories = Object.keys(DiscordConstants);

        if (filterPattern) {
            const matching = u.filterBySubstring(categories, filterPattern, k => k);

            if (!matching.length) return { count: 0, categories: [], message: `No constant categories matching "${filterPattern}"` };

            const results: Record<string, unknown> = {};
            for (const key of matching.slice(0, LIMITS.DISCORD.ENDPOINTS_FILTERED)) {
                const val = DiscordConstants[key];
                if (val && typeof val === "object") {
                    const entries = Object.entries(val as Record<string, unknown>);
                    results[key] = {
                        type: typeof val,
                        keyCount: entries.length,
                        sample: Object.fromEntries(entries.slice(0, LIMITS.DISCORD.CONSTANTS_SAMPLE).map(([k, v]) => [k, typeof v === "function" ? "(function)" : v])),
                    };
                } else {
                    results[key] = val;
                }
            }
            return { count: matching.length, entries: results };
        }

        const summary = Object.fromEntries(categories.map(key => {
            const val = DiscordConstants[key];
            return [key, { type: typeof val, keyCount: val && typeof val === "object" ? Object.keys(val).length : undefined }];
        }));
        return { count: categories.length, categories: summary };
    }

    if (action === "tokens") {
        if (!DesignTokensModule) return { error: true, message: "Design tokens not found" };

        const t = DesignTokensModule;
        const colorKeys = Object.keys(t.colors ?? {});

        if (filterPattern) {
            const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
            const q = norm(filterPattern);
            const matchingColors = colorKeys.filter(k => norm(k).includes(q) || norm(t.colors[k]?.css ?? "").includes(q));
            const colorDetails = matchingColors.slice(0, LIMITS.DISCORD.TOKEN_COLOR_SLICE).map(k => ({
                name: k,
                cssVar: t.colors[k]?.css,
            }));
            return { query: filterPattern, colorCount: matchingColors.length, colors: colorDetails };
        }

        return {
            semanticColors: colorKeys.length,
            rawColors: Object.keys(t.unsafe_rawColors ?? {}).length,
            themes: Object.keys(t.themes ?? {}),
            themeEnum: Object.fromEntries(Object.entries(t.themes ?? {}).filter(([, v]) => typeof v === "string")),
            shadows: Object.keys(t.shadows ?? {}).slice(0, LIMITS.DISCORD.TOKEN_SHADOWS_SLICE),
            radii: t.radii,
            spacing: t.spacing,
            modules: t.modules ? Object.keys(t.modules) : undefined,
            sampleColors: colorKeys.slice(0, LIMITS.DISCORD.TOKEN_COLOR_SLICE).map(k => ({ name: k, css: t.colors[k]?.css })),
            tip: "Use filter to search colors by name",
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
        guild: guild ? { id: guild.id, name: guild.name, ownerId: guild.ownerId } : null,
    };
}
