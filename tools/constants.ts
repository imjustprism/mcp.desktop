/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const INTL_HASH_FRAGMENT = "[A-Za-z0-9+/]{6}";
export const INTL_HASH_FULL_RE = /^[A-Za-z0-9+/]{6}$/;

export const createIntlHashDotRegex = () => /\.t\.([A-Za-z0-9+/]{6})/g;
export const createIntlHashBracketRegex = () => /\.t\["([A-Za-z0-9+/]{6})"\]/g;
export const createIntlKeyPatternRegex = () => /#\{intl::([A-Z][A-Z0-9_]*)/g;

export const JS_RESERVED_KEYWORDS = new Set("function return const if for while else switch case break continue typeof instanceof void delete new throw try catch finally class extends super import export default let var this null undefined true false".split(" "));

export const MINIFIED_VARS_PATTERN = /(?<![a-zA-Z_$])([etnirsoclu])(?=\s*[,)}:.]|$)/g;
export const FORBIDDEN_PATCH_PATTERNS = [/\be,t,n\b/, /function\s*\(\s*e\s*\)/, /return!0/, /return!1/] as const;

export const NOISE_STRINGS = new Set(["use strict", "function", "object", "string", "number", "boolean", "undefined", "symbol", "bigint", "default"]);

export const CSS_CLASS_RE = /^[a-zA-Z][\w-]*_[a-f0-9]{6}$/;
export const CSS_CLASS_CAPTURE_RE = /\b([a-zA-Z][\w-]*_[a-f0-9]{6})\b/;

export const STORE_NAME_RE = () => /="([A-Z][a-zA-Z]{2,40}Store)"/g;
export const STRING_LITERAL_RE = () => /"([^"\\]{6,80})"/g;
export const FUNC_CALL_RE = () => /\.([a-zA-Z_$][\w$]{4,25})\(/g;
export const ENUM_MEMBER_RE = () => /\.([A-Z][A-Z_0-9]{3,30})(?=[,;)}\]&|?!\s])/g;
export const IDENT_ASSIGN_RE = () => /(?<=[;{,\n])([a-zA-Z_$][a-zA-Z0-9_$]{7,35})(?==(?!=))/g;
export const PROP_ASSIGN_RE = () => /([a-zA-Z_$][\w$]{3,25}):\s*(?!\s*function)/g;

export const ANCHOR_TYPE_ORDER: Readonly<Record<string, number>> = {
    intl: 0,
    storeName: 1,
    errorString: 2,
    combined: 3,
    string: 4,
    ident: 5,
    enum: 6,
    funcCall: 7,
    prop: 8,
};

export const OPTION_TYPE_NAMES: readonly string[] = ["STRING", "NUMBER", "BIGINT", "BOOLEAN", "SELECT", "SLIDER", "COMPONENT", "CUSTOM"];

export const CONTEXT = {
    FIND_SNIPPET_BEFORE: 40,
    FIND_SNIPPET_AFTER: 120,
    MATCH_CONTEXT_PAD: 80,
    MATCHED_TEXT_MAX: 300,
    REPLACEMENT_BEFORE: 100,
    REPLACEMENT_AFTER: 300,
    FIND_CONTEXT_BEFORE: 300,
    FIND_CONTEXT_AFTER: 500,
    ANCHOR_RADIUS: 500,
    MAX_ANCHORS: 12,
    SEARCH_SNIPPET: 80,
    ANNOTATE_MAX_LENGTH: 50000,
} as const;

export const REGEX_CACHE_MAX_SIZE = 100;

export const CACHE_TTL = {
    MODULE_SOURCE_MS: 60_000,
    BATCH_COUNT_MS: 60_000,
    LOCALE_MESSAGES_MS: 300_000,
    MODULE_IDS_MS: 5_000,
    CSS_INDEX_MS: 60_000,
} as const;

export const INTL_DETECTION = {
    MIN_LOCALE_KEY_COUNT: 10_000,
} as const;

export const SANITIZE = {
    TOSTRING_MAX: 500,
    MAX_DEPTH: 10,
    SET_MAX: 50,
    ARRAY_MAX: 100,
    KEYS_MAX: 50,
    OUTPUT_MAX_LENGTH: 50_000,
} as const;

export const HOOK_EFFECT_FLAGS = { LAYOUT: 4, INSERTION: 2, PASSIVE: 8 } as const;

export const FIBER_TAGS = {
    FUNCTION_COMPONENT: 0,
    CLASS_COMPONENT: 1,
    CONTEXT_PROVIDER: 10,
    FORWARD_REF: 11,
    MEMO_COMPONENT: 14,
    SIMPLE_MEMO_COMPONENT: 15,
} as const;

export const COMPONENT_FIBER_TAGS: ReadonlySet<number> = new Set([
    FIBER_TAGS.FUNCTION_COMPONENT,
    FIBER_TAGS.CLASS_COMPONENT,
    FIBER_TAGS.FORWARD_REF,
    FIBER_TAGS.MEMO_COMPONENT,
    FIBER_TAGS.SIMPLE_MEMO_COMPONENT,
]);

export const DEFAULT_TOOL_LIMIT = 20;

export const INTL_TARGETS_SCAN_CAP = 500;

export const LIMITS = {
    REACT: {
        MAX_DEPTH: 50,
        MAX_LIMIT: 100,
        MAX_BREADTH: 50,
        MAX_PROCESS: 15000,
        PARENT_SEARCH_DEPTH: 10,
        MAX_STYLES: 50,
        MAX_PROP_KEYS_PREVIEW: 8,
        MAX_HOOKS: 30,
        MAX_PATH_DEPTH: 15,
        MAX_CLASS_LIST: 5,
        ATTR_VALUE_SLICE: 100,
        CLASS_NAME_SLICE: 200,
        TREE_TEXT_SLICE: 50,
        CONTEXT_SAMPLE_KEYS: 8,
        CONTEXT_VALUE_KEYS: 15,
        PROP_FILTER_MIN_LENGTH: 2,
        PRIMITIVE_IMPORTED_BY: 40,
        STATE_VALUES_MAX: 10,
        DEFAULT_DEPTH: 10,
        DEFAULT_LIMIT: 20,
        DEFAULT_BREADTH: 10,
    },
    STORE: {
        LIST_SLICE: 100,
        SUGGESTIONS: 10,
        METHOD_MATCHES: 15,
        SERIALIZE_CALL: 3000,
        SNAPSHOT_MAX: 50,
        SNAPSHOT_SERIALIZE: 500,
        SNAPSHOT_TOTAL_BUDGET: 8000,
    },
    FLUX: {
        SLICE: 100,
        MAX_LIMIT: 1000,
    },
    DISCORD: {
        API_SERIALIZE: 5000,
        ENDPOINTS_FILTERED: 50,
        ENDPOINTS_DEFAULT: 20,
        ENDPOINT_VALUE_SLICE: 60,
        ENUM_MATCHES: 10,
        ENUM_KEYS: 30,
        ENUM_SAMPLE: 20,
        COMMON_MODULES_SLICE: 100,
        TOKEN_COLOR_SLICE: 50,
        CONSTANTS_SAMPLE: 20,
        TOKEN_SHADOWS_SLICE: 15,
    },
    TRACE: {
        SUMMARIZE_SERIALIZE: 500,
        SUMMARIZE_TEXT_SLICE: 500,
        GET_CAPTURE_SLICE: 50,
        STOP_CAPTURE_SLICE: 100,
        DURATION_DEFAULT_MS: 10_000,
        DURATION_MIN_MS: 1_000,
        DURATION_MAX_MS: 60_000,
        MAX_CAPTURES_DEFAULT: 100,
        MAX_CAPTURES_CAP: 500,
        GRACE_MS: 60_000,
    },
    INTERCEPT: {
        SUMMARIZE_ARGS: 300,
        SUMMARIZE_RESULT: 200,
        GET_CAPTURE_SLICE: 30,
        STOP_CAPTURE_SLICE: 50,
        AVAILABLE_FUNCTIONS: 20,
        DURATION_DEFAULT_MS: 30_000,
        DURATION_MIN_MS: 5_000,
        DURATION_MAX_MS: 120_000,
        MAX_CAPTURES_DEFAULT: 50,
        MAX_CAPTURES_CAP: 200,
        EXPORT_OBJECTS_SLICE: 5,
        GRACE_MS: 60_000,
    },
    CSS: {
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
        SOURCE_MAXLENGTH_DEFAULT: 50_000,
        SOURCE_MAXLENGTH_CAP: 50_000,
        WATCH_DURATION_DEFAULT_MS: 30_000,
        WATCH_DURATION_MIN_MS: 5_000,
        WATCH_DURATION_MAX_MS: 120_000,
        WATCH_MAX_CAPTURES_DEFAULT: 100,
        WATCH_MAX_CAPTURES_CAP: 500,
        FUNCTION_BRACE_SCAN_WINDOW: 500,
        FUNCTION_HEADER_SCAN_LIMIT: 200,
        FUNCTION_SOURCE_MAX: 20_000,
        STRUCTURE_MAX_FUNCTIONS: 50,
        STRUCTURE_MAX_CLASSES: 20,
        STRUCTURE_MAX_METHODS: 80,
        STRUCTURE_MAX_STRINGS: 30,
        STRUCTURE_MAX_ASSIGNMENTS: 30,
        CONTEXT_DEFAULT_CHARS: 100,
        EXPORT_SOURCE_PREVIEW: 5_000,
        EXPORT_KEYS_PREVIEW: 30,
        EXPORT_SOURCE_SNIPPET: 200,
        WATCHGET_RESULT_SLICE: 50,
        WATCHSTOP_RESULT_SLICE: 100,
        STRUCTURE_VARIABLES_OUT: 20,
    },
    PLUGIN: {
        LIST_MAX_FILTERED: 100,
        LIST_MAX_DEFAULT: 50,
        FIND_SLICE: 100,
        PATCHES_SLICE: 10,
        SUGGESTIONS: 5,
    },
    SEARCH: {
        DEFAULT_LIMIT: 10,
        MIN_PATTERNS: 2,
        MAX_PATTERNS: 10,
        CANON_SNIPPET_BEFORE: 30,
        CANON_SNIPPET_AFTER: 50,
        MATCH_PREVIEW: 100,
    },
    TEST_PATCH: {
        LOCATION_SLICE: 80,
        SYNTAX_ERROR_SLICE: 200,
        LITERAL_MIN_LEN: 4,
        LITERAL_SLICE: 40,
        SAMPLE_PREVIEW: 3,
        INVALID_MATCH_SLICE: 100,
        MULTI_MATCH_SLICE: 5,
        SCORE_MAX: 10,
        SCORE_PENALTY_NOT_UNIQUE: 4,
        SCORE_PENALTY_NO_MATCH: 5,
        SCORE_PENALTY_ERROR: 3,
        SCORE_PENALTY_WARNING: 1,
        MAX_PATTERN_LENGTH: 300,
        EXCESSIVE_RANGE_WARN: 200,
        EXCESSIVE_RANGE_ERROR: 500,
        LARGE_LOOKBEHIND: 100,
        MAX_CAPTURES: 4,
    },
    PATCH: {
        UNIQUE_EARLY_EXIT: 11,
        UNIQUE_MODULE_PREVIEW: 10,
        PLUGIN_MATCH_EARLY_EXIT: 5,
        PLUGIN_MATCH_PREVIEW: 5,
        PLUGIN_SIMILAR_SUGGESTIONS: 5,
        ANALYZE_MAX_ISSUES: 100,
        ANALYZE_FIND_SLICE: 100,
        ANALYZE_CANON_SLICE: 100,
        LINT_MIN_FIND_LENGTH: 20,
        LINT_MAX_FIND_LENGTH: 200,
        LINT_MAX_CAPTURES: 3,
        LINT_PREVIEW_SLICE: 200,
        LINT_EARLY_EXIT: 5,
        FINDS_MAX_SPECS: 100,
        FINDS_RESULT_LIMIT: 100,
        CONFLICTS_EARLY_EXIT: 2,
        CONFLICTS_FIND_SLICE: 60,
        CONFLICTS_DEFAULT_TOP_N: 20,
        DIFF_EARLY_EXIT: 2,
        DIFF_FIND_SLICE: 80,
        DIFF_MATCH_SLICE: 120,
        DIFF_REPLACE_SLICE: 120,
        BROKEN_EARLY_EXIT: 5,
        BROKEN_FIND_SLICE: 100,
        BROKEN_CANON_SLICE: 100,
        BROKEN_FRAGMENT_MIN_LEN: 8,
        BROKEN_FRAGMENT_MAX: 5,
        BROKEN_FRAGMENT_EARLY_EXIT: 3,
        BROKEN_FRAGMENT_PREVIEW: 3,
        BROKEN_FRAGMENT_SLICE: 60,
        RAW_FIND_SLICE: 200,
        REPLACEMENT_MATCH_SLICE: 150,
        REPLACEMENT_REPLACE_SLICE: 100,
    },
    ANALYSIS: {
        SCORE_MIN: 1,
        SCORE_MAX: 10,
        SCORE_INTL: 3,
        SCORE_STRING_LITERAL: 2,
        SCORE_PROP_NAME: 2,
        SCORE_IDENTIFIER: 1,
        SCORE_LOOKBEHIND: 1,
        SCORE_PENALTY_MINIFIED: 3,
        SCORE_PENALTY_FORBIDDEN: 2,
        SCORE_PENALTY_SHORT: 1,
        SCORE_PENALTY_GENERIC: 2,
        SCORE_PENALTY_WILDCARD: 1,
        SCORE_PENALTY_LONG: 1,
        SCORE_PENALTY_CAPTURES: 1,
        SCORE_PENALTY_NO_ANCHORS: 1,
        SCORE_PENALTY_NO_MATCH: 5,
        SCORE_PENALTY_AMBIGUOUS: 3,
        BASE_SCORE: 5,
    },
} as const;
