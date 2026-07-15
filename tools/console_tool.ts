import { ConsoleToolArgs, ToolResult } from "../types";

export interface ConsoleEntry {
    ts: number;
    level: "error" | "warn";
    text: string;
}

const MAX_ENTRIES = 500;
const MAX_TEXT_LEN = 400;
const DEFAULT_RECENT_LIMIT = 30;

const buffer: ConsoleEntry[] = [];
let installedAt = 0;
let originals: { error: typeof console.error; warn: typeof console.warn } | null = null;

function stringifyArg(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack?.split("\n").slice(0, 3).join(" | ") ?? arg.message;
    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

function push(level: ConsoleEntry["level"], args: unknown[]): void {
    try {
        const text = args.map(stringifyArg).join(" ").slice(0, MAX_TEXT_LEN);
        buffer.push({ ts: Date.now(), level, text });
        if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    } catch {}
}

const onWindowError = (e: ErrorEvent) => push("error", [`Uncaught: ${e.message} @ ${e.filename ?? "?"}:${e.lineno ?? "?"}`]);
const onRejection = (e: PromiseRejectionEvent) => push("error", ["Unhandled rejection:", e.reason]);

export function installConsoleCapture(): void {
    if (originals) return;
    originals = { error: console.error, warn: console.warn };
    installedAt = Date.now();
    console.error = (...args: unknown[]) => { push("error", args); originals!.error.apply(console, args); };
    console.warn = (...args: unknown[]) => { push("warn", args); originals!.warn.apply(console, args); };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
}

export function uninstallConsoleCapture(): void {
    if (!originals) return;
    console.error = originals.error;
    console.warn = originals.warn;
    originals = null;
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onRejection);
    buffer.length = 0;
}

export function recentConsole(level?: ConsoleEntry["level"], sinceMs?: number, limit = DEFAULT_RECENT_LIMIT): ConsoleEntry[] {
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const out: ConsoleEntry[] = [];
    for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
        const e = buffer[i];
        if (e.ts < cutoff) break;
        if (level && e.level !== level) continue;
        out.push(e);
    }
    return out.reverse();
}

export function handleConsole(args: ConsoleToolArgs): ToolResult {
    const action = args.action ?? "recent";

    if (action === "clear") {
        const cleared = buffer.length;
        buffer.length = 0;
        return { cleared };
    }

    if (action === "stats") {
        let errors = 0;
        for (const e of buffer) if (e.level === "error") errors++;
        return {
            capturing: originals !== null,
            capturingSinceMs: installedAt ? Date.now() - installedAt : 0,
            buffered: buffer.length,
            errors,
            warnings: buffer.length - errors,
        };
    }

    const limit = Math.min(Math.max(args.limit ?? DEFAULT_RECENT_LIMIT, 1), 100);
    const entries = recentConsole(args.level, args.sinceMs, limit);
    return {
        count: entries.length,
        capturing: originals !== null,
        entries: entries.map(e => ({ agoMs: Date.now() - e.ts, level: e.level, text: e.text })),
    };
}
