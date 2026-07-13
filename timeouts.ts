export const DEFAULT_TIMEOUT_MS = 30_000;

const TIMEOUT_MS: Readonly<Record<string, number>> = {
    "module:loadLazy": 120_000,
    "module:watch": 120_000,
    "module:watchGet": 60_000,
    "trace:start": 120_000,
    "trace:store": 120_000,
    "intercept:set": 120_000,
    "patch:analyze": 60_000,
    "patch:finds": 60_000,
    search: 60_000,
};

export function getToolTimeout(toolName: string, action?: string): number {
    const key = action ? `${toolName}:${action}` : toolName;
    return TIMEOUT_MS[key] ?? DEFAULT_TIMEOUT_MS;
}
