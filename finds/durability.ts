export type DurabilityTier =
    | "intl"
    | "storeName"
    | "errorString"
    | "string"
    | "method"
    | "prop"
    | "weak";

export interface Durability {
    readonly score: number;
    readonly tier: DurabilityTier;
    readonly reasons: readonly string[];
}

const DURABILITY_MIN = 0;
const DURABILITY_MAX = 10;
const MIN_ERROR_COPY_LEN = 8;
const MIN_DISTINCTIVE_FIND_LEN = 8;

const INTL_PLACEHOLDER_RE = /#\{intl::[\w$+/]+(?:::\w+)?\}/;
const RAW_INTL_ACCESS_RE = /\.t(?:\.[A-Za-z0-9+/]{6}(?![A-Za-z0-9+/])|\["[A-Za-z0-9+/]{6}"\])/;
const STORE_NAME_RE = /"([A-Z][A-Za-z0-9]{2,40})Store"/;
const CSS_HASH_SEG_RE = /[A-Za-z0-9][-_]{1,2}([A-Za-z0-9]{5,8})(?![A-Za-z0-9])/g;
const HEX_HASH_RE = /[a-f0-9]{16,}/;
const METHOD_CALL_RE = /\.([A-Za-z_$][\w$]{4,})\(/;
const PROP_ASSIGN_RE = /\b([A-Za-z_$][\w$]{3,}):/;
const STRING_LITERAL_RE = /"([^"\\]{4,120})"|'([^'\\]{4,120})'/;
const LONG_NUMBER_RE = /(?<![.\w])\d{3,}/g;
const MINIFIED_IDENT_RE = /(?<![\w$.])[a-z](?=\s*[,)}.:;[\]])/gi;

function clamp(n: number): number {
    return Math.max(DURABILITY_MIN, Math.min(DURABILITY_MAX, n));
}

function isHashLikeSuffix(s: string): boolean {
    return /^[a-f0-9]{6}$/.test(s) || (/[0-9]/.test(s) && /[a-zA-Z]/.test(s)) || /[a-z][A-Z]/.test(s);
}

function hasCssHashSuffix(find: string): boolean {
    for (const m of find.matchAll(CSS_HASH_SEG_RE)) {
        if (isHashLikeSuffix(m[1])) return true;
    }
    return false;
}

function isHashyStoreName(body: string): boolean {
    return /[0-9]/.test(body) && /[a-f0-9]{4,}/i.test(body);
}

export function scoreDurability(find: string): Durability {
    const reasons: string[] = [];
    let score = 5;
    let tier: DurabilityTier = "weak";
    let intlPlaceholder = false;
    const storeMatch = STORE_NAME_RE.exec(find);

    if (INTL_PLACEHOLDER_RE.test(find)) {
        score = 10;
        tier = "intl";
        intlPlaceholder = true;
        reasons.push("anchored on an intl key (#{intl::KEY}) — content-independent, stable per key name");
    } else if (RAW_INTL_ACCESS_RE.test(find)) {
        score = 5;
        tier = "intl";
        reasons.push("relies on a raw 6-char intl hash — prefer #{intl::KEY} so it survives copy edits and stays readable");
    } else if (storeMatch && !isHashyStoreName(storeMatch[1])) {
        score = 8;
        tier = "storeName";
        reasons.push("anchored on a Flux store display-name literal — stable across builds");
    } else {
        const strMatch = STRING_LITERAL_RE.exec(find);
        const lit = strMatch ? (strMatch[1] ?? strMatch[2] ?? "") : "";
        if (strMatch && lit !== "use strict") {
            if (/\s/.test(lit) && lit.length >= MIN_ERROR_COPY_LEN) {
                score = 7;
                tier = "errorString";
                reasons.push("anchored on an error/log-style string literal — stable unless the copy is edited");
            } else {
                score = 6;
                tier = "string";
                reasons.push("anchored on a string literal");
            }
        } else if (METHOD_CALL_RE.test(find)) {
            score = 6;
            tier = "method";
            reasons.push("anchored on a method name — stable unless the method is renamed");
        } else if (PROP_ASSIGN_RE.test(find)) {
            score = 5;
            tier = "prop";
            reasons.push("anchored on a property name — reasonably stable, but object shapes can be reordered");
        } else {
            reasons.push("no strong anchor (no intl key, store name, or distinctive string) — likely to drift");
        }
    }

    const longNums = find.match(LONG_NUMBER_RE);
    if (longNums && !intlPlaceholder && tier !== "errorString") {
        const penalty = Math.min(4, longNums.length * 2);
        score -= penalty;
        reasons.push(`contains ${longNums.length} multi-digit number(s) (e.g. ${longNums[0]}) — likely volatile module/chunk ids`);
    }

    if (!intlPlaceholder && hasCssHashSuffix(find)) {
        score -= 3;
        reasons.push("contains a per-build CSS hash suffix (name_ab12cd) — match the logical prefix instead");
    }

    if (HEX_HASH_RE.test(find) && !intlPlaceholder) {
        score -= 3;
        reasons.push("contains a 16+ char hex hash (CDN asset / content hash) — rotates when the asset or build changes");
    }

    const minified = find.match(MINIFIED_IDENT_RE);
    if (minified && minified.length >= 3 && !intlPlaceholder) {
        score -= 2;
        reasons.push("leans on several 1-2 char identifiers — minified names are renamed every build (use \\i in the match, not the find)");
    }

    if (tier === "weak" || tier === "string") {
        const inner = find.replace(/^["']|["']$/g, "");
        if (/^[A-Za-z][A-Za-z.,'!?-]*(?: [A-Za-z.,'!?-]+)+$/.test(inner) && !/[{}()[\];=:]/.test(find)) {
            score -= 1;
            reasons.push("plain English copy — rots when Discord edits the wording; prefer the intl key if one exists");
        }
    }

    if (find.replace(/#\{intl::[^}]+\}/g, "").length < MIN_DISTINCTIVE_FIND_LEN && !intlPlaceholder) {
        score -= 1;
        reasons.push("very short — higher risk of matching the wrong module after a rebuild");
    }

    return { score: clamp(score), tier, reasons };
}
