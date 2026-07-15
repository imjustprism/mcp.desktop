/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginOption, PluginToolArgs, ToolResult } from "../types";
import { plugins, pluginSettings, startPlugin, stopPlugin } from "../webpack";
import { LIMITS, OPTION_TYPE_NAMES } from "./constants";
import * as u from "./utils";

function ensurePluginSettings(name: string) {
    return (pluginSettings[name] ??= {});
}

const REDACTED = "[redacted]";
const SECRET_KEY_RE = /token|secret|password|passwd|api[_-]?key|\bauth(?!or)|email/i;

function isSecretSetting(key: string, opt: PluginOption): boolean {
    if (SECRET_KEY_RE.test(key)) return true;
    return /password|token/i.test(OPTION_TYPE_NAMES[opt.type ?? 0] ?? "");
}

export async function handlePlugin(args: PluginToolArgs): Promise<ToolResult> {
    const { action, name, setting: settingKey, value: settingValue } = args;
    const showPatches = args.showPatches ?? false;
    const validate = args.validate ?? false;

    const findPlugin = (filter: string) => {
        const plugin = plugins[filter];
        if (plugin) return { plugin, name: filter };
        const similar = u.rankedSuggestions(Object.keys(plugins), filter, LIMITS.PLUGIN.SUGGESTIONS);
        return { error: true, message: `Plugin "${filter}" not found`, suggestions: similar.length ? similar : undefined };
    };

    if (action === "enable" || action === "disable" || action === "toggle") {
        if (!name) return u.missingArg("name");

        const result = findPlugin(name);
        if ("error" in result) return result;
        const { plugin, name: pluginName } = result;

        if (plugin.required) return { error: true, message: `"${pluginName}" is required` };

        const isEnabled = plugin.started ?? false;
        const shouldEnable = action === "toggle" ? !isEnabled : action === "enable";

        if (shouldEnable === isEnabled) {
            return { success: true, name: pluginName, enabled: isEnabled, message: `Already ${isEnabled ? "enabled" : "disabled"}` };
        }

        const settings = ensurePluginSettings(pluginName);
        if (plugin.patches?.length) {
            settings.enabled = shouldEnable;
            return { success: true, name: pluginName, enabled: shouldEnable, requiresRestart: true, message: `${shouldEnable ? "Enabled" : "Disabled"}, restart required` };
        }

        if (shouldEnable) settings.enabled = true;
        const success = shouldEnable ? startPlugin(plugin as Parameters<typeof startPlugin>[0]) : stopPlugin(plugin as Parameters<typeof stopPlugin>[0]);
        if (!shouldEnable && success) settings.enabled = false;
        return { success, name: pluginName, enabled: success ? shouldEnable : isEnabled, message: success ? (shouldEnable ? "Enabled" : "Disabled") : `Failed to ${shouldEnable ? "start" : "stop"}` };
    }

    if (action === "settings" || action === "setSetting") {
        if (!name) return u.missingArg("name");

        const result = findPlugin(name);
        if ("error" in result) return result;
        const { plugin, name: pluginName } = result;

        const currentSettings = pluginSettings[pluginName] ?? {};

        const options: Record<string, PluginOption> = plugin.settings?.def ?? plugin.options ?? {};

        if (action === "settings") {
            const settingsInfo = Object.fromEntries(Object.entries(options).map(([key, opt]) => {
                const o = opt as PluginOption & { description?: string; default?: unknown; options?: unknown; restartNeeded?: boolean };
                const secret = isSecretSetting(key, opt);
                return [key, {
                    type: OPTION_TYPE_NAMES[opt.type ?? 0] ?? "UNKNOWN",
                    description: o.description,
                    currentValue: secret ? REDACTED : (currentSettings[key] ?? o.default),
                    default: secret ? REDACTED : o.default,
                    options: o.options,
                    restartNeeded: o.restartNeeded ?? false,
                }];
            }));

            return { name: pluginName, enabled: plugin.started ?? false, settingsCount: Object.keys(options).length, settings: settingsInfo };
        }

        if (!settingKey) return u.missingArg("setting");
        if (!(settingKey in options)) {
            return { error: true, message: `Setting "${settingKey}" not found`, availableSettings: Object.keys(options) };
        }

        const opt = options[settingKey];
        const secret = isSecretSetting(settingKey, opt);
        const restartNeeded = (opt as PluginOption & { restartNeeded?: boolean }).restartNeeded ?? false;
        const oldValue = currentSettings[settingKey];
        ensurePluginSettings(pluginName)[settingKey] = settingValue;
        return {
            success: true,
            name: pluginName,
            setting: settingKey,
            type: OPTION_TYPE_NAMES[opt.type ?? 0] ?? "UNKNOWN",
            oldValue: secret ? REDACTED : oldValue,
            newValue: secret ? REDACTED : settingValue,
            restartNeeded,
            message: restartNeeded ? "Restart required" : undefined,
        };
    }

    let pluginList = Object.entries(plugins);
    if (name) pluginList = u.filterBySubstring(pluginList, name, ([nm]) => nm);

    const maxPlugins = name ? LIMITS.PLUGIN.LIST_MAX_FILTERED : LIMITS.PLUGIN.LIST_MAX_DEFAULT;
    const pluginInfos = pluginList.slice(0, maxPlugins).map(([nm, plugin]) => {
        const patchCount = plugin.patches?.length ?? 0;
        const info: Record<string, unknown> = { name: nm, enabled: plugin.started ?? false };

        if (patchCount) {
            info.hasPatches = true;
            info.patchCount = patchCount;
        }
        if (plugin.required) info.required = true;

        if (showPatches && plugin.patches) {
            info.patches = plugin.patches.slice(0, LIMITS.PLUGIN.PATCHES_SLICE).map(p => ({
                find: u.patchFindAsString(p.find).slice(0, LIMITS.PLUGIN.FIND_SLICE),
                replacementCount: u.getReplacements(p).length,
            }));
        }

        if (validate && plugin.patches) {
            const ok = plugin.patches.filter(p => {
                const m = u.canonFindMatcher(p.find);
                return (m.isRegex ? u.findModuleIds(m.test, 2).length : u.countModuleMatches(m.canonical, 2)) === 1;
            }).length;
            const broken = plugin.patches.length - ok;
            info.health = { ok, broken, status: u.healthStatus(broken, plugin.patches.length) };
        }

        return info;
    });

    const enabledCount = pluginList.filter(([, p]) => p.started).length;
    const truncated = pluginList.length > maxPlugins;
    return {
        total: pluginList.length,
        enabled: enabledCount,
        returned: pluginInfos.length,
        truncated,
        plugins: pluginInfos,
        note: truncated ? `Showing ${pluginInfos.length} of ${pluginList.length}. Pass name to filter (substring match).` : undefined,
    };
}
