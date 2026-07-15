const SUFFIXES: readonly string[] = [
    "LABEL", "TITLE", "DESCRIPTION", "TOOLTIP", "TOOLTIP_TEXT", "BUTTON", "BUTTON_LABEL",
    "PLACEHOLDER", "HEADER", "BODY", "TEXT", "SUBTITLE", "SUBTEXT", "SUBHEADER", "A11Y_LABEL",
    "ARIA_LABEL", "ERROR", "HINT", "NAME", "MENU_LABEL", "MENU_ITEM", "CONFIRM", "CANCEL",
    "ACTION", "MESSAGE", "HEADING", "CONTENT", "SUMMARY", "DEFAULT", "HELP", "HELP_TEXT",
    "CTA", "PROMPT", "TAB_LABEL", "EMPTY_STATE", "EMPTY_STATE_TITLE", "MODAL", "MODAL_TITLE",
    "MODAL_HEADER", "MODAL_BODY", "MODAL_DESCRIPTION", "MODAL_SUBTITLE", "MODAL_CONFIRM"
];
const PREFIXES: readonly string[] = ["A11Y"];
const MAX_MESSAGE_LEN = 200;
const SKIP_WORDS: ReadonlySet<string> = new Set(["THE", "A", "AN", "OF", "TO", "FOR", "AND", "OR", "IN", "ON"]);
const MAX_CANDIDATES = 300;
const MAX_PREFIX_WORDS = 8;

function messageToWords(message: string): string[] {
    const cleaned = message
        .slice(0, MAX_MESSAGE_LEN)
        .replace(/['’]/g, "")
        .replace(/!!\{[^}]*\}!!/g, " ")
        .replace(/\{[^}]*\}/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_~`>#]/g, " ");
    return cleaned.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

export function generateKeyCandidates(message: string): string[] {
    const words = messageToWords(message);
    if (!words.length) return [];

    const bases = new Set<string>();
    bases.add(words.join("_"));
    for (let k = 2; k <= Math.min(MAX_PREFIX_WORDS, words.length); k++) {
        bases.add(words.slice(0, k).join("_"));
    }
    const trimmed = words.filter(w => !SKIP_WORDS.has(w));
    if (trimmed.length && trimmed.length !== words.length) {
        bases.add(trimmed.join("_"));
        for (let k = 2; k <= Math.min(MAX_PREFIX_WORDS, trimmed.length); k++) {
            bases.add(trimmed.slice(0, k).join("_"));
        }
    }

    const out = new Set<string>();
    const add = (c: string) => { if (out.size < MAX_CANDIDATES && c.length >= 2) out.add(c); };
    for (const base of bases) {
        add(base);
        for (const suffix of SUFFIXES) add(`${base}_${suffix}`);
        for (const prefix of PREFIXES) add(`${prefix}_${base}`);
    }
    return [...out];
}

export function recoverIntlKey(hash: string, message: string, hashKey: (key: string) => string): string | null {
    for (const candidate of generateKeyCandidates(message)) {
        if (hashKey(candidate) === hash) return candidate;
    }
    return null;
}
