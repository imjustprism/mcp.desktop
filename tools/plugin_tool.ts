/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canonicalizeMatch } from "@utils/patches";

import { PluginManagerAPI, PluginOption, PluginSettings, PluginToolArgs, ToolResult, VencordPlugin } from "../types";
import { countModuleMatchesFast } from "./utils";

const TYPE_NAMES: Record<number, string> = { 0: "STRING", 1: "NUMBER", 2: "BIGINT", 3: "BOOLEAN", 4: "SELECT", 5: "SLIDER", 6: "COMPONENT", 7: "CUSTOM" };

export async function handlePluginTool(args: PluginToolArgs): Promise<ToolResult> {
    const { action, name, setting: settingKey, value: settingValue } = args;
    const showPatches = args.showPatches ?? false;
    const validate = args.validate ?? false;

    const { plugins } = Vencord.Plugins;
    const { startPlugin, stopPlugin } = Vencord.Api.PluginManager as PluginManagerAPI;
    const Settings = Vencord.Settings as { plugins: Record<string, PluginSettings> };

    const findPlugin = (filter: string) => {
        const plugin = plugins[filter] as VencordPlugin | undefined;
        if (plugin) return { plugin, name: filter };
        const similar = Object.keys(plugins).filter(n => n.toLowerCase().includes(filter.toLowerCase())).slice(0, 5);
        return { error: true, message: `Plugin "${filter}" not found`, suggestions: similar.length ? similar : undefined };
    };

    if (action === "enable" || action === "disable" || action === "toggle") {
        if (!name) return { error: true, message: "name required for enable/disable/toggle" };

        const result = findPlugin(name);
        if ("error" in result) return result;
        const { plugin, name: pluginName } = result;

        if (plugin.required) return { error: true, message: `Plugin "${pluginName}" is required and cannot be disabled` };

        const isEnabled = plugin.started ?? false;
        const shouldEnable = action === "toggle" ? !isEnabled : action === "enable";

        if (shouldEnable === isEnabled) {
            return { success: true, name: pluginName, enabled: isEnabled, message: `Plugin already ${isEnabled ? "enabled" : "disabled"}` };
        }

        const hasPatches = plugin.patches?.length;
        if (hasPatches) {
            Settings.plugins[pluginName].enabled = shouldEnable;
            return { success: true, name: pluginName, enabled: shouldEnable, requiresRestart: true, message: `Plugin ${shouldEnable ? "enabled" : "disabled"}, restart required to apply patches` };
        }

        if (shouldEnable) {
            Settings.plugins[pluginName].enabled = true;
            const success = startPlugin(plugin);
            return { success, name: pluginName, enabled: success, message: success ? "Plugin enabled" : "Failed to start plugin" };
        }

        const success = stopPlugin(plugin);
        if (success) Settings.plugins[pluginName].enabled = false;
        return { success, name: pluginName, enabled: !success, message: success ? "Plugin disabled" : "Failed to stop plugin" };
    }

    if (action === "settings" || action === "setSetting") {
        if (!name) return { error: true, message: "name required for settings actions" };

        const result = findPlugin(name);
        if ("error" in result) return result;
        const { plugin, name: pluginName } = result;

        const pluginSettings = Settings.plugins[pluginName] ?? {};
        const options = plugin.options ?? {};

        if (action === "settings") {
            const settingsInfo: Record<string, { type: string; description?: string; currentValue: unknown; default?: unknown; options?: unknown }> = {};

            for (const [key, opt] of Object.entries(options) as [string, PluginOption][]) {
                const o = opt as unknown as Record<string, unknown>;
                settingsInfo[key] = {
                    type: TYPE_NAMES[opt.type ?? 0] ?? "UNKNOWN",
                    description: o.description as string | undefined,
                    currentValue: pluginSettings[key] ?? o.default,
                    default: o.default,
                    options: o.options
                };
            }

            return { name: pluginName, enabled: plugin.started ?? false, settingsCount: Object.keys(options).length, settings: settingsInfo };
        }

        if (!settingKey) return { error: true, message: "setting key required for setSetting" };
        if (!(settingKey in options)) {
            return { error: true, message: `Setting "${settingKey}" not found in plugin "${pluginName}"`, availableSettings: Object.keys(options) };
        }

        const oldValue = pluginSettings[settingKey];
        Settings.plugins[pluginName][settingKey] = settingValue;
        return { success: true, name: pluginName, setting: settingKey, oldValue, newValue: settingValue };
    }

    let pluginList = Object.entries(plugins) as [string, VencordPlugin][];
    if (name) {
        const lower = name.toLowerCase();
        pluginList = pluginList.filter(([nm]) => nm.toLowerCase().includes(lower));
    }

    const maxPlugins = name ? 50 : 20;
    const pluginInfos = pluginList.slice(0, maxPlugins).map(([nm, plugin]) => {
        const patchCount = plugin.patches?.length ?? 0;
        const info: Record<string, unknown> = { name: nm, enabled: plugin.started ?? false };

        if (patchCount) {
            info.hasPatches = true;
            info.patchCount = patchCount;
        }
        if (plugin.required) info.required = true;

        if (showPatches && plugin.patches) {
            info.patches = plugin.patches.slice(0, 10).map(p => ({
                find: String(typeof p.find === "string" ? p.find : p.find).slice(0, 100),
                replacementCount: Array.isArray(p.replacement) ? p.replacement.length : 1
            }));
        }

        if (validate && plugin.patches) {
            let ok = 0, broken = 0;
            for (const patch of plugin.patches) {
                const rawFind = typeof patch.find === "string" ? patch.find : patch.find?.toString() ?? "";
                const count = countModuleMatchesFast(canonicalizeMatch(rawFind), 2);
                if (count === 1) ok++;
                else broken++;
            }
            info.health = {
                ok,
                broken,
                status: broken === 0 ? "HEALTHY" : broken < plugin.patches.length / 2 ? "DEGRADED" : "BROKEN"
            };
        }

        return info;
    });

    const enabledCount = pluginList.filter(([, p]) => p.started).length;
    return {
        total: pluginList.length,
        enabled: enabledCount,
        plugins: pluginInfos,
        note: pluginList.length > maxPlugins ? "Use name param to filter" : undefined
    };
}
