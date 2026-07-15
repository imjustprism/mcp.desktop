import { IntlToolArgs, ToolResult } from "../types";
import { createIntlHashBracketRegex, createIntlHashDotRegex, DEFAULT_TOOL_LIMIT, INTL_HASH_FRAGMENT, INTL_HASH_FULL_RE, INTL_TARGETS_SCAN_CAP } from "./constants";
import * as u from "./utils";

function getMessage(hash: string): string | null {
    const locale = u.getLocaleMessages();
    if (locale?.[hash]) return u.extractIntlText(locale[hash]);
    return u.getIntlMessageFromHash(hash);
}

interface IntlEntry { hash: string; message: string; key?: string; find?: string }

export async function handleIntl(args: IntlToolArgs): Promise<ToolResult> {
    const { action, key, hash, query, moduleId } = args;
    const limit = args.limit ?? DEFAULT_TOOL_LIMIT;

    if (action === "hash" || (key && !action)) {
        if (!key) return u.missingArg("key");
        const trimmed = key.trim();
        const isRaw = /::raw\}?$/.test(trimmed);
        const cleanKey = trimmed.replace(/^#\{intl::/, "").replace(/(?:::raw)?\}$/, "");
        if (isRaw && INTL_HASH_FULL_RE.test(cleanKey)) {
            const message = getMessage(cleanKey);
            const rk = u.getIntlKeyFromHash(cleanKey);
            const exists = !!message && message !== cleanKey;
            return { key: rk, hash: cleanKey, find: exists ? u.intlFind(cleanKey, rk) : null, message: exists ? message : null, exists, warning: exists ? undefined : "Hash not found in Discord intl definitions" };
        }
        const h = u.runtimeHashMessageKey(cleanKey);
        const message = getMessage(h);
        const exists = !!message && message !== h;
        return { key: cleanKey, hash: h, find: exists ? u.intlFind(h, cleanKey) : null, message: exists ? message : null, exists, warning: exists ? undefined : "Key not found in Discord intl definitions, hash may be invalid" };
    }

    if (action === "reverse" || (hash && !action && !key)) {
        if (!hash) return u.missingArg("hash");
        if (!INTL_HASH_FULL_RE.test(hash)) return { error: true, message: `Invalid hash format: expected 6 base64 chars, got "${hash}" (${hash.length} chars)` };
        const k = u.getIntlKeyFromHash(hash);
        const message = getMessage(hash);
        const exists = !!message && message !== hash;
        return { hash, key: k, find: exists ? u.intlFind(hash, k) : null, message: exists ? message : null, exists, warning: exists ? undefined : "Hash not found in Discord intl definitions" };
    }

    if (action === "search" || (query && !action)) {
        if (!query) return u.missingArg("query");
        const locale = u.getLocaleMessages();
        if (!locale) return { query, count: 0, matches: [] };

        const queryLower = query.toLowerCase();
        const terms = queryLower.split(/\s+/).filter(w => w.length >= 2);
        const hashMap = u.buildIntlHashToKeyMap();
        const exact: IntlEntry[] = [];
        const partial: IntlEntry[] = [];

        for (const [h, arr] of Object.entries(locale)) {
            const text = u.extractIntlText(arr);
            if (!text) continue;
            const lower = text.toLowerCase();
            if (!(terms.length > 1 ? terms.every(t => lower.includes(t)) : lower.includes(queryLower))) continue;

            const known = hashMap.get(h);
            const entry: IntlEntry = { hash: h, message: text.slice(0, 200) };
            if (known) { entry.key = known; entry.find = u.intlFind(h, known); }
            (lower === queryLower ? exact : partial).push(entry);
        }

        const combined = [...exact, ...partial];
        const matches = combined.slice(0, limit);
        return { query, count: combined.length, returned: matches.length, truncated: combined.length > matches.length ? true : undefined, matches };
    }

    if (action === "scan") {
        if (!moduleId) return u.missingArg("moduleId");
        const source = u.getModuleSource(moduleId);
        if (!source) return { error: true, message: `Module ${moduleId} not found` };

        const patterns = [createIntlHashDotRegex(), createIntlHashBracketRegex(), new RegExp(`intl\\.string\\(\\w+\\.t\\.(${INTL_HASH_FRAGMENT})\\)`, "g"), new RegExp(`"(${INTL_HASH_FRAGMENT})":\\s*\\[`, "g")];
        const found = new Set<string>();
        for (const regex of patterns) {
            let m: RegExpExecArray | null;
            while ((m = regex.exec(source))) found.add(m[1]);
        }

        const hashes = [...found].slice(0, limit).map(h => {
            const k = u.getIntlKeyFromHash(h);
            return { hash: h, key: k, find: u.intlFind(h, k), message: getMessage(h) };
        });
        return { moduleId, count: found.size, returned: hashes.length, truncated: found.size > hashes.length ? true : undefined, hashes };
    }

    if (action === "targets") {
        const cleanKey = key?.trim().replace(/^#\{intl::/, "").replace(/(?:::raw)?\}$/, "");
        const h = cleanKey ? u.runtimeHashMessageKey(cleanKey) : hash;
        if (!h) return u.missingArg("key or hash");
        if (!INTL_HASH_FULL_RE.test(h)) return { error: true, message: `Invalid hash format: expected 6 base64 chars, got "${h}" (${h.length} chars)` };
        const message = getMessage(h);
        const all = u.findModuleIds(src => src.includes(`.t.${h}`) || src.includes(`.t["${h}"]`), INTL_TARGETS_SCAN_CAP);
        const warning = cleanKey && (!message || message === h) ? "Key not found in Discord intl definitions, or its module is not loaded this session" : undefined;
        return { key: cleanKey || u.getIntlKeyFromHash(h), hash: h, message, count: all.length, returned: Math.min(all.length, limit), truncated: all.length > limit ? true : undefined, modules: all.slice(0, limit), warning };
    }

    if (action === "recover") {
        const result = u.recoverIntlKeys(limit);
        return {
            ...result,
            persistedTotal: u.learnedKeyCount(),
            note: result.recovered
                ? "Recovered key names for hashes absent from the static map by hashing candidates derived from each live message and proving the exact match. These resolve in reverse/scan/targets/genFinds and persist to disk (self-validated on reload)."
                : "No new keys recovered this session (loaded locale hashes are already mapped, or their messages did not yield a candidate that hashes back)."
        };
    }

    if (action === "clearCache") {
        u.clearIntlCache();
        return { message: "Intl hash-to-key cache cleared. It rebuilds from the static key map plus this-session recovered keys, which survive (they are re-proven by hashing, not blindly trusted)." };
    }

    return { error: true, message: "action: hash, reverse, search, scan, targets, recover, clearCache" };
}
