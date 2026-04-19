/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as PluginManager from "@api/PluginManager";
const { startPlugin, stopPlugin } = PluginManager;
import { Settings } from "@api/Settings";
import { factoryListeners, filters, findAll, findByPropsLazy, findStore, findStoreLazy, search, wreq } from "@webpack";
import * as Common from "@webpack/common";
import { Constants, Flux, FluxDispatcher, i18n, SnowflakeUtils } from "@webpack/common";

import { DesignTokens, FluxActionHandlers, FluxDispatcherInternal, GatewaySocket, PlatformUtils as PlatformUtilsType, PluginSettings, SnowflakeUtilsType, VencordPlugin, WebpackModule } from "./types";

function getLivePlugins(): Record<string, VencordPlugin> {
    return (PluginManager.plugins ?? {}) as any;
}
export const plugins = new Proxy({} as Record<string, VencordPlugin>, {
    get: (_, key) => getLivePlugins()[key as string],
    ownKeys: () => Reflect.ownKeys(getLivePlugins()),
    getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(getLivePlugins(), key),
    has: (_, key) => key in getLivePlugins(),
});

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
export const DiscordConstants = Constants as any as Record<string, unknown>;

export const getSnowflakeUtils = (): SnowflakeUtilsType => SnowflakeUtils as any;
export const getCommonModules = (): Record<string, unknown> => Common as any;
export const getFluxDispatcherInternal = (): FluxDispatcherInternal => FluxDispatcher as any;
export const getActionHandlers = (): FluxActionHandlers | undefined => (FluxDispatcher as any as FluxDispatcherInternal)._actionHandlers;

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
            } catch {
                return null;
            }
        }
        return null;
    }
}

export const pluginSettings = Settings.plugins as Record<string, PluginSettings>;

export { factoryListeners, filters, findAll, findStore, Flux, FluxDispatcher, i18n, search, startPlugin, stopPlugin, wreq };
