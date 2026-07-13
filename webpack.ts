import { plugins as vencordPlugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { factoryListeners, filters, findAll, findByPropsLazy, findStore, search, wreq } from "@webpack";
import * as Common from "@webpack/common";
import { Constants, Flux, FluxDispatcher, i18n, SnowflakeUtils } from "@webpack/common";

import { DesignTokens, FluxDispatcherInternal, PluginSettings, SnowflakeUtilsType, VencordPlugin } from "./types";

const livePlugins = () => (vencordPlugins ?? {}) as unknown as Record<string, VencordPlugin>;
export const plugins = new Proxy({} as Record<string, VencordPlugin>, {
    get: (_, key) => livePlugins()[key as string],
    ownKeys: () => Reflect.ownKeys(livePlugins()),
    getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(livePlugins(), key),
    has: (_, key) => key in livePlugins(),
});

export const DesignTokensModule = findByPropsLazy("unsafe_rawColors", "colors") as DesignTokens;

export const Endpoints = Constants.Endpoints as Record<string, string | ((...args: string[]) => string)>;
export const DiscordConstants = Constants as unknown as Record<string, unknown>;

export const getSnowflakeUtils = (): SnowflakeUtilsType => SnowflakeUtils as unknown as SnowflakeUtilsType;
export const getCommonModules = (): Record<string, unknown> => Common as unknown as Record<string, unknown>;
export const getFluxDispatcherInternal = (): FluxDispatcherInternal => FluxDispatcher as unknown as FluxDispatcherInternal;

export function resolveStore(name: string): { store: Record<string, unknown>; name: string } | null {
    const tryFind = (n: string): Record<string, unknown> | undefined => {
        try { return findStore(n) as Record<string, unknown> | undefined; } catch { return undefined; }
    };
    const direct = tryFind(name);
    if (direct) return { store: direct, name };
    if (!name.endsWith("Store")) {
        const withSuffix = name + "Store";
        const suffixed = tryFind(withSuffix);
        if (suffixed) return { store: suffixed, name: withSuffix };
    }
    return null;
}

export const pluginSettings = Settings.plugins as Record<string, PluginSettings>;

export { patches as webpackPatches } from "@webpack/patcher";
export { factoryListeners, filters, findAll, findStore, Flux, FluxDispatcher, i18n, search, wreq };
export { startPlugin, stopPlugin } from "@api/PluginManager";
