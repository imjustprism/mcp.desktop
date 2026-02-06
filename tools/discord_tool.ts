/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findAll } from "@webpack";
import { ChannelStore, GuildStore, RestAPI, SelectedChannelStore, SelectedGuildStore, UserStore } from "@webpack/common";

import { DiscordAPIError, DiscordToolArgs, GatewaySocket, ToolResult } from "../types";
import { findStore, serializeResult } from "./utils";

export async function handleDiscordTool(args: DiscordToolArgs): Promise<ToolResult> {
    const { action, method, endpoint, body, id, filter: filterPattern, memberName } = args;

    if (action === "api") {
        if (!method || !endpoint) return { error: true, message: "method and endpoint required" };

        const apiCall = RestAPI[method];
        if (!apiCall) return { error: true, message: `Invalid method: ${method}. Valid: get, post, patch, put, del` };

        try {
            const response = await apiCall({ url: endpoint, body });
            const respBody = typeof response.body === "object" && response.body !== null
                ? serializeResult(response.body, 5000)
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
            const timestamp = Number(BigInt(id) >> 22n) + 1420070400000;
            const date = new Date(timestamp);
            return {
                id,
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
        const Constants = (Vencord as unknown as { Webpack?: { Common?: { Constants?: { Endpoints?: Record<string, unknown> } } } }).Webpack?.Common?.Constants;
        const endpoints = Constants?.Endpoints;
        if (!endpoints) return { error: true, message: "Endpoints not found" };

        let entries = Object.entries(endpoints);
        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            entries = entries.filter(([k]) => k.toLowerCase().includes(lower));
        }

        const maxEndpoints = filterPattern ? 50 : 20;
        return {
            found: true,
            count: entries.length,
            endpoints: Object.fromEntries(entries.slice(0, maxEndpoints).map(([k, v]) => [k, typeof v === "function" ? (v as (id1: string, id2: string) => string)("ID1", "ID2").slice(0, 60) : v])),
            note: entries.length > maxEndpoints ? "Use filter param to narrow results" : undefined
        };
    }

    if (action === "common") {
        const common = (Vencord as unknown as { Webpack?: { Common?: Record<string, unknown> } }).Webpack?.Common ?? {};

        let keys = Object.keys(common);
        if (filterPattern) {
            const lower = filterPattern.toLowerCase();
            keys = keys.filter(k => k.toLowerCase().includes(lower));
        }

        return {
            count: keys.length,
            modules: keys.sort().slice(0, 30).map(k => ({ name: k, type: typeof common[k] })),
            note: keys.length > 30 ? "Use filter param to narrow results" : undefined
        };
    }

    if (action === "enum") {
        if (!memberName) return { error: true, message: "memberName required" };

        const mods = findAll(m => m?.[memberName] !== undefined && typeof (m as Record<string, unknown>)[memberName] === "number");

        return {
            count: mods.length,
            matches: mods.slice(0, 10).map(mod => {
                const keys = Object.keys(mod as object).filter(k => typeof (mod as Record<string, unknown>)[k] === "number" || typeof (mod as Record<string, unknown>)[k] === "string");
                return { keys: keys.slice(0, 30), sample: Object.fromEntries(keys.slice(0, 20).map(k => [k, (mod as Record<string, unknown>)[k]])) };
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
            .slice(0, 5)
            .map(r => ({ name: r.name.split("/").pop()?.slice(0, 50) ?? "", duration: Math.round(r.duration) }));

        return { pageLoadMs: pageLoad, domReadyMs: domReady, resources: resourceStats, now: Math.round(performance.now()) };
    }

    if (action === "waitForIpc") {
        const timeout = args.timeout ?? 10000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (UserStore.getCurrentUser()) return { ready: true, elapsed: Date.now() - start };
            await new Promise(r => setTimeout(r, 200));
        }
        return { ready: false, elapsed: Date.now() - start, message: "Timed out waiting for Discord to be ready" };
    }

    if (action === "gateway") {
        const gatewayStore = findStore("GatewayConnectionStore") as { getSocket(): GatewaySocket | null; isConnected(): boolean } | null;
        if (!gatewayStore) return { error: true, message: "GatewayConnectionStore not found" };

        const socket = gatewayStore.getSocket();
        if (!socket) return { connected: false, message: "No active gateway connection" };

        const now = Date.now();
        return {
            connected: gatewayStore.isConnected(),
            state: socket.connectionState_,
            sessionId: socket.sessionId ? `${socket.sessionId.slice(0, 8)}...` : null,
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
