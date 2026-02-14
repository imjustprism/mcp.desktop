/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { factoryListeners, filters, findAll, findByPropsLazy, findStore, findStoreLazy, search, wreq } from "@webpack";
import * as Common from "@webpack/common";
import { Constants, Flux, FluxDispatcher, i18n, SnowflakeUtils } from "@webpack/common";

import { DesignTokens, FluxActionHandlers, FluxDispatcherInternal, GatewaySocket, PlatformUtils as PlatformUtilsType, PluginSettings, SnowflakeUtilsType, WebpackModule } from "./types";

const ICONS_ANCHOR = ["AngleBracketsIcon", "StaffBadgeIcon"] as const;
const UI_BARREL_ANCHOR = ["ConfirmModal", "ExpressiveModal"] as const;

export const IconsModule = findByPropsLazy(...ICONS_ANCHOR) as Record<string, unknown>;
export const UIBarrelModule = findByPropsLazy(...UI_BARREL_ANCHOR) as Record<string, unknown>;

export const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore") as {
    getSocket(): GatewaySocket | null;
    isConnected(): boolean;
};

export const ExperimentStore = findStoreLazy("ExperimentStore") as Record<string, unknown>;
export const IconUtilsModule = findByPropsLazy("getUserAvatarURL", "getGuildIconURL") as Record<string, (...args: unknown[]) => string>;
export const PlatformUtilsModule = findByPropsLazy("isWindows", "isLinux") as PlatformUtilsType;
export const DesignTokensModule = findByPropsLazy("unsafe_rawColors", "colors") as DesignTokens;

export const Endpoints = Constants.Endpoints as Record<string, unknown>;
export const DiscordConstants = Constants as unknown as Record<string, unknown>;

export function getSnowflakeUtils(): SnowflakeUtilsType {
    return SnowflakeUtils as unknown as SnowflakeUtilsType;
}

export function getCommonModules(): Record<string, unknown> {
    return Common as unknown as Record<string, unknown>;
}

export function getFluxDispatcherInternal(): FluxDispatcherInternal {
    return FluxDispatcher as unknown as FluxDispatcherInternal;
}

export function getActionHandlers(): FluxActionHandlers | undefined {
    return (FluxDispatcher as unknown as FluxDispatcherInternal)._actionHandlers;
}

function findModuleIdByProps(props: readonly string[]): string | null {
    for (const [id, mod] of Object.entries(wreq.c) as [string, WebpackModule][]) {
        if (!mod?.exports || typeof mod.exports !== "object") continue;
        if (props.every(p => p in mod.exports)) return id;
    }
    return null;
}

export function getIconsModuleId(): string | null {
    return findModuleIdByProps(ICONS_ANCHOR);
}

export function getUIBarrelModuleId(): string | null {
    return findModuleIdByProps(UI_BARREL_ANCHOR);
}

export function resolveStore(name: string): { store: Record<string, unknown>; name: string } | null {
    try {
        return { store: findStore(name) as Record<string, unknown>, name };
    } catch {
        if (!name.endsWith("Store")) {
            const withSuffix = name + "Store";
            try {
                return { store: findStore(withSuffix) as Record<string, unknown>, name: withSuffix };
            } catch { return null; }
        }
        return null;
    }
}

export const pluginSettings = Settings.plugins as Record<string, PluginSettings>;

export { factoryListeners, filters, findAll, findStore, Flux, FluxDispatcher, i18n, plugins, search, startPlugin, stopPlugin, wreq };
