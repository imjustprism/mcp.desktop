/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const createIntlHashDotRegex = () => /\.t\.([A-Za-z0-9+/]{6})/g;
export const createIntlHashBracketRegex = () => /\.t\["([A-Za-z0-9+/]{6,8})"\]/g;
export const createIntlKeyPatternRegex = (global = false) =>
    global ? /#\{intl::([A-Z][A-Z0-9_]*)/g : /#\{intl::([A-Z][A-Z0-9_]*)/;

export const JS_RESERVED_KEYWORDS = new Set([
    "function", "return", "const", "if", "for", "while", "else",
    "switch", "case", "break", "continue", "typeof", "instanceof",
    "void", "delete", "new", "throw", "try", "catch", "finally",
    "class", "extends", "super", "import", "export", "default",
    "let", "var", "this", "null", "undefined", "true", "false",
]);

export const MINIFIED_VARS_PATTERN = /(?<![a-zA-Z_$])([etnirsoclu])(?=\s*[,)}:.]|$)/g;
export const FORBIDDEN_PATCH_PATTERNS = [
    /\be,t,n\b/,
    /function\s*\(\s*e\s*\)/,
    /return!0/,
    /return!1/,
] as const;

export const NOISE_STRINGS = new Set([
    "use strict", "function", "object", "string", "number",
    "boolean", "undefined", "symbol", "bigint", "default",
]);

export const MANA_COMPONENT_RE = /"data-mana-component":"([^"]+)"/g;
export const MANA_COMPONENT_SINGLE_RE = /"data-mana-component":"([^"]+)"/;
export const ICON_DETECT_RE = /size:.*width:.*height:.*color:/;
export const CSS_CLASS_RE = /^[a-zA-Z][\w-]*_[a-f0-9]{6}$/;
export const CSS_CLASS_CAPTURE_RE = /\b([a-zA-Z][\w-]*_[a-f0-9]{6})\b/;

export const STORE_NAME_RE = () => /="([A-Z][a-zA-Z]{2,40}Store)"/g;
export const STRING_LITERAL_RE = () => /"([^"\\]{6,80})"/g;
export const FUNC_CALL_RE = () => /\.([a-zA-Z_$][\w$]{4,25})\(/g;
export const ENUM_MEMBER_RE = () => /\.([A-Z][A-Z_0-9]{3,30})(?=[,;)}\]&|?!\s])/g;
export const IDENT_ASSIGN_RE = () => /(?<=[;{,\n])([a-zA-Z_$][a-zA-Z0-9_$]{7,35})(?==(?!=))/g;
export const PROP_ASSIGN_RE = () => /([a-zA-Z_$][\w$]{3,25}):\s*(?!\s*function)/g;

export const ANCHOR_TYPE_ORDER: Readonly<Record<string, number>> = {
    intl: 0, storeName: 1, errorString: 2, combined: 3, string: 4, ident: 5, enum: 6, funcCall: 7, prop: 8
};

export const OPTION_TYPE_NAMES: Readonly<Record<number, string>> = {
    0: "STRING", 1: "NUMBER", 2: "BIGINT", 3: "BOOLEAN", 4: "SELECT", 5: "SLIDER", 6: "COMPONENT", 7: "CUSTOM"
};

export const CONTEXT = {
    FIND_SNIPPET_BEFORE: 40,
    FIND_SNIPPET_AFTER: 120,
    MATCH_CONTEXT_PAD: 80,
    MATCHED_TEXT_MAX: 300,
    REPLACEMENT_BEFORE: 50,
    REPLACEMENT_AFTER: 200,
    FIND_CONTEXT_BEFORE: 300,
    FIND_CONTEXT_AFTER: 500,
    ANCHOR_RADIUS: 500,
    MAX_ANCHORS: 12,
    SEARCH_SNIPPET: 50,
    ANNOTATE_MAX_LENGTH: 50000,
} as const;

export const REGEX_CACHE_MAX_SIZE = 100;

export const INTERESTING_PROP_KEYWORDS = new Set([
    "message", "channel", "guild", "user", "member", "role",
]);

export const LIMITS = {
    REACT: {
        MAX_DEPTH: 50,
        MAX_LIMIT: 100,
        MAX_BREADTH: 50,
        MAX_PROCESS: 15000,
        MAX_NAMED_COMPONENTS: 100,
        PARENT_SEARCH_DEPTH: 10,
        MAX_STYLES: 50,
        MAX_PROP_KEYS_PREVIEW: 8,
        MAX_HOOKS: 30,
        MAX_PATH_DEPTH: 15,
        MAX_CLASS_LIST: 5,
        ATTR_VALUE_SLICE: 100,
        CLASS_NAME_SLICE: 200,
        TEXT_CONTENT_MAX: 5000,
        TEXT_PREVIEW: 1000,
        CHILD_TEXT_SLICE: 200,
        CHILD_TEXTS_MAX: 20,
        STYLE_MODIFY_MAX: 20,
        SET_ATTRIBUTE_MAX: 10,
        TREE_TEXT_SLICE: 50,
        CONTEXT_SAMPLE_KEYS: 8,
        CONTEXT_VALUE_KEYS: 15,
        PROP_FILTER_MIN_LENGTH: 2,
        STATE_VALUES_MAX: 10,
    },
    STORE: {
        LIST_SLICE: 100,
        SUGGESTIONS: 10,
        METHOD_MATCHES: 15,
        SERIALIZE_CALL: 3000,
    },
    FLUX: {
        SLICE: 100,
    },
    DISCORD: {
        API_SERIALIZE: 5000,
        WAITFORIPC_POLL_MS: 200,
        ENDPOINTS_FILTERED: 50,
        ENDPOINTS_DEFAULT: 20,
        ENDPOINT_VALUE_SLICE: 60,
        ENUM_MATCHES: 10,
        ENUM_KEYS: 30,
        ENUM_SAMPLE: 20,
        SLOWEST_RESOURCES: 5,
        RESOURCE_NAME_SLICE: 50,
        SESSION_ID_SLICE: 8,
        COMMON_MODULES_SLICE: 100,
        CONSTANTS_CATEGORIES: 30,
        CONSTANTS_SAMPLE_VALUES: 20,
        EXPERIMENT_SLICE: 50,
        TOKEN_COLOR_SLICE: 50,
        TOKEN_RAW_COLOR_SLICE: 30,
        ICON_UTIL_FUNCTIONS: 40,
    },
    TRACE: {
        SUMMARIZE_SERIALIZE: 500,
        SUMMARIZE_TEXT_SLICE: 500,
        GET_CAPTURE_SLICE: 50,
        STOP_CAPTURE_SLICE: 100,
        HANDLER_SLICE: 30,
    },
    INTERCEPT: {
        SUMMARIZE_ARGS: 300,
        SUMMARIZE_RESULT: 200,
        GET_CAPTURE_SLICE: 30,
        STOP_CAPTURE_SLICE: 50,
        AVAILABLE_FUNCTIONS: 20,
    },
    CSS: {
        INDEX_TTL_MS: 60000,
        MAX_CLASSES_PER_MODULE: 100,
        TOP_MODULES: 20,
        SAMPLE_CLASSES: 5,
    },
    MODULE: {
        DIFF_CONTEXT_PAD: 60,
        DIFF_MAX_REGION_LEN: 300,
        DIFF_MAX_REGIONS: 10,
        DIFF_RESYNC_WINDOW: 500,
        DIFF_RESYNC_MATCH: 8,
        SUGGEST_TOP_N: 20,
        SUGGEST_MIN_FIND_LEN: 6,
        SUGGEST_MAX_COMBINED_LEN: 120,
        SUGGEST_MAX_COMBINED_GAP: 200,
    },
    COMPONENT: {
        INDEX_TTL_MS: 60000,
        MAX_CONTROLS: 30,
        MAX_PROPS: 40,
        MAX_MATCHES: 20,
        MAX_OPTIONS: 15,
        PROP_SRC_SLICE: 500,
    },
    PLUGIN: {
        LIST_MAX_FILTERED: 100,
        LIST_MAX_DEFAULT: 50,
        FIND_SLICE: 100,
        PATCHES_SLICE: 10,
        SUGGESTIONS: 5,
    },
} as const;
