export type TokKind =
    | "ident"
    | "keyword"
    | "str"
    | "template"
    | "number"
    | "regex"
    | "punct";

export interface Token {
    readonly kind: TokKind;
    readonly start: number;
    readonly end: number;
}

interface TemplateChunk {
    readonly resumeAt: number;
    readonly entersHole: boolean;
}

const KEYWORDS: ReadonlySet<string> = new Set([
    "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "export", "extends", "finally", "for", "function", "if",
    "import", "in", "instanceof", "new", "return", "super", "switch", "this", "throw",
    "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "await",
    "async", "of", "get", "set", "null", "true", "false", "undefined"
]);

const VALUE_KEYWORDS: ReadonlySet<string> = new Set([
    "this", "super", "true", "false", "null", "undefined"
]);

const OPERATORS: readonly string[] = [
    ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
    "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
    "+=", "-=", "*=", "%=", "&=", "|=", "^=", "**", "<<", ">>"
];

const NUM_RE = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const IDENT_RE = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const ID_START_RE = /[\p{ID_Start}]/u;
const REGEX_FLAG_RE = /[a-z]/i;

function isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
    if (c === "$" || c === "_") return true;
    if (c <= "\x7f") return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    return ID_START_RE.test(c);
}

const OPERATORS_BY_FIRST_CHAR = new Map<string, string[]>();
for (const op of OPERATORS) {
    const bucket = OPERATORS_BY_FIRST_CHAR.get(op[0]);
    if (bucket) bucket.push(op);
    else OPERATORS_BY_FIRST_CHAR.set(op[0], [op]);
}

function regexAllowed(src: string, prev: Token | undefined): boolean {
    if (!prev) return true;
    switch (prev.kind) {
        case "number":
        case "str":
        case "regex":
        case "ident":
            return false;
        case "template":
            return src.slice(prev.end - 2, prev.end) === "${";
        case "keyword":
            return !VALUE_KEYWORDS.has(src.slice(prev.start, prev.end));
        case "punct": {
            const p = src.slice(prev.start, prev.end);
            return p !== ")" && p !== "]" && p !== "}" && p !== "++" && p !== "--";
        }
    }
    return prev.kind satisfies never;
}

function scanString(src: string, start: number): number {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "\n" || c === "\r") return i;
        if (c === quote) return i + 1;
        i++;
    }
    return src.length;
}

function scanRegex(src: string, start: number): number {
    let i = start + 1;
    let inClass = false;
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { i++; break; }
        else if (c === "\n") return i;
        i++;
    }
    while (i < src.length && REGEX_FLAG_RE.test(src[i])) i++;
    return i;
}

function scanLineComment(src: string, start: number): number {
    let i = start + 2;
    while (i < src.length && src[i] !== "\n") i++;
    return i;
}

function scanBlockComment(src: string, start: number): number {
    let i = start + 2;
    while (i < src.length) {
        if (src[i] === "*" && src[i + 1] === "/") return i + 2;
        i++;
    }
    return src.length;
}

function matchOperator(src: string, i: number): string | null {
    const bucket = OPERATORS_BY_FIRST_CHAR.get(src[i]);
    if (!bucket) return null;
    for (const op of bucket) {
        if (src.startsWith(op, i)) return op;
    }
    return null;
}

export function tokenize(src: string): Token[] {
    const toks: Token[] = [];
    const templateHoleDepth: number[] = [];
    let braceDepth = 0;
    let i = 0;
    const n = src.length;

    const prev = (): Token | undefined => toks[toks.length - 1];

    function scanTemplateChunk(openerIndex: number): TemplateChunk {
        let j = openerIndex + 1;
        while (j < n) {
            const c = src[j];
            if (c === "\\") { j += 2; continue; }
            if (c === "`") {
                toks.push({ kind: "template", start: openerIndex, end: j + 1 });
                return { resumeAt: j + 1, entersHole: false };
            }
            if (c === "$" && src[j + 1] === "{") {
                toks.push({ kind: "template", start: openerIndex, end: j + 2 });
                return { resumeAt: j + 2, entersHole: true };
            }
            j++;
        }
        toks.push({ kind: "template", start: openerIndex, end: n });
        return { resumeAt: n, entersHole: false };
    }

    while (i < n) {
        const c = src[i];

        if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f" || c === "\u00a0" || c === "\ufeff") {
            i++;
            continue;
        }

        if (c === "/") {
            const next = src[i + 1];
            if (next === "/") { i = scanLineComment(src, i); continue; }
            if (next === "*") { i = scanBlockComment(src, i); continue; }
            if (regexAllowed(src, prev())) {
                const end = scanRegex(src, i);
                toks.push({ kind: "regex", start: i, end });
                i = end;
                continue;
            }
            const end = next === "=" ? i + 2 : i + 1;
            toks.push({ kind: "punct", start: i, end });
            i = end;
            continue;
        }

        if (c === '"' || c === "'") {
            const end = scanString(src, i);
            toks.push({ kind: "str", start: i, end });
            i = end;
            continue;
        }

        if (c === "`") {
            const { resumeAt, entersHole } = scanTemplateChunk(i);
            i = resumeAt;
            if (entersHole) templateHoleDepth.push(braceDepth);
            continue;
        }

        if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
            NUM_RE.lastIndex = i;
            const m = NUM_RE.exec(src);
            if (m && m.index === i) {
                toks.push({ kind: "number", start: i, end: i + m[0].length });
                i += m[0].length;
                continue;
            }
        }

        if (isIdentStart(c)) {
            IDENT_RE.lastIndex = i;
            const m = IDENT_RE.exec(src);
            if (m && m.index === i) {
                const text = m[0];
                const p = prev();
                const prevText = p?.kind === "punct" ? tokenText(src, p) : "";
                const afterDot = prevText === "." || prevText === "?.";
                const kind: TokKind = KEYWORDS.has(text) && !afterDot ? "keyword" : "ident";
                toks.push({ kind, start: i, end: i + text.length });
                i += text.length;
                continue;
            }
        }

        if (c === "{") {
            braceDepth++;
            toks.push({ kind: "punct", start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === "}") {
            if (templateHoleDepth.length && braceDepth === templateHoleDepth[templateHoleDepth.length - 1]) {
                templateHoleDepth.pop();
                const { resumeAt, entersHole } = scanTemplateChunk(i);
                i = resumeAt;
                if (entersHole) templateHoleDepth.push(braceDepth);
                continue;
            }
            if (braceDepth > 0) braceDepth--;
            toks.push({ kind: "punct", start: i, end: i + 1 });
            i++;
            continue;
        }

        const op = matchOperator(src, i);
        if (op) {
            toks.push({ kind: "punct", start: i, end: i + op.length });
            i += op.length;
            continue;
        }

        toks.push({ kind: "punct", start: i, end: i + 1 });
        i++;
    }

    return toks;
}

export function tokenText(src: string, t: Token): string {
    return src.slice(t.start, t.end);
}
