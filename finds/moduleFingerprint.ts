/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ModuleFingerprint {
    readonly intlHashes: readonly string[];
    readonly storeNames: readonly string[];
    readonly errorStrings: readonly string[];
    readonly cssHashes: readonly string[];
    readonly landmarkCount: number;
}

export interface FingerprintMatch {
    readonly score: number;
    readonly sharedIntl: number;
    readonly sharedStore: number;
    readonly sharedError: number;
}

const MAX_PER_SET = 40;
const MIN_ERROR_COPY_LEN = 11;
const MAX_ERROR_COPY_LEN = 200;

const INTL_WEIGHT = 4;
const STORE_WEIGHT = 4;
const ERROR_WEIGHT = 2;
const CSS_WEIGHT = 1;

const INTL_HASH_RE = /\.t(?:\.([A-Za-z0-9+/]{6})(?![A-Za-z0-9+/])|\["([A-Za-z0-9+/]{6})"\])/g;
const STRING_LITERAL_RE = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g;
const STORE_NAME_RE = /^[A-Z][A-Za-z0-9]{2,40}Store$/;
const CSS_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]*(?:[-_]([A-Za-z0-9]{6})|__([A-Za-z0-9]{4,12}))$/;

function capped(values: readonly string[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of values) {
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= MAX_PER_SET) break;
    }
    return out;
}

function isCssToken(token: string): boolean {
    const m = CSS_TOKEN_RE.exec(token);
    if (!m) return false;
    return /\d/.test(m[1] ?? m[2] ?? "");
}

function isErrorCopy(lit: string): boolean {
    if (lit.length < MIN_ERROR_COPY_LEN || lit.length > MAX_ERROR_COPY_LEN) return false;
    if (!lit.includes(" ")) return false;
    if (!/[a-z]/.test(lit)) return false;
    const tokens = lit.split(/\s+/).filter(t => t.length > 0);
    return tokens.some(t => !isCssToken(t));
}

export function fingerprintModule(source: string): ModuleFingerprint {
    const intl: string[] = [];
    const stores: string[] = [];
    const errors: string[] = [];
    const css: string[] = [];

    for (const m of source.matchAll(INTL_HASH_RE)) {
        intl.push(m[1] ?? m[2] ?? "");
    }

    for (const m of source.matchAll(STRING_LITERAL_RE)) {
        const lit = m[1] ?? m[2] ?? "";
        if (STORE_NAME_RE.test(lit)) {
            stores.push(lit);
            continue;
        }
        if (isErrorCopy(lit)) errors.push(lit);
        for (const token of lit.split(/\s+/)) {
            if (token.length > 0 && isCssToken(token)) css.push(token);
        }
    }

    const intlHashes = capped(intl);
    const storeNames = capped(stores);
    const errorStrings = capped(errors);
    const cssHashes = capped(css);

    return {
        intlHashes,
        storeNames,
        errorStrings,
        cssHashes,
        landmarkCount: intlHashes.length + storeNames.length + errorStrings.length + cssHashes.length
    };
}

function overlap(a: readonly string[], b: readonly string[]): { readonly shared: number; readonly union: number } {
    const setA = new Set(a);
    const setB = new Set(b);
    let shared = 0;
    for (const v of setA) {
        if (setB.has(v)) shared++;
    }
    return { shared, union: setA.size + setB.size - shared };
}

export function fingerprintSimilarity(a: ModuleFingerprint, b: ModuleFingerprint): FingerprintMatch {
    const intl = overlap(a.intlHashes, b.intlHashes);
    const store = overlap(a.storeNames, b.storeNames);
    const error = overlap(a.errorStrings, b.errorStrings);
    const css = overlap(a.cssHashes, b.cssHashes);

    const sharedWeight =
        INTL_WEIGHT * intl.shared +
        STORE_WEIGHT * store.shared +
        ERROR_WEIGHT * error.shared +
        CSS_WEIGHT * css.shared;
    const unionWeight =
        INTL_WEIGHT * intl.union +
        STORE_WEIGHT * store.union +
        ERROR_WEIGHT * error.union +
        CSS_WEIGHT * css.union;

    return {
        score: unionWeight === 0 ? 0 : sharedWeight / unionWeight,
        sharedIntl: intl.shared,
        sharedStore: store.shared,
        sharedError: error.shared
    };
}
