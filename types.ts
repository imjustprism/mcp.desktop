/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginSettingDef } from "@utils/types";

type JSONPrimitive = string | number | boolean | null;
type JSONObject = { [key: string]: JSONValue };
export type JSONValue = JSONPrimitive | JSONValue[] | JSONObject;
type AnyFn = (...args: unknown[]) => unknown;

type JSONSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

interface JSONSchemaProperty {
    type: JSONSchemaType;
    description?: string;
    default?: JSONValue;
    items?: JSONSchemaProperty;
    enum?: JSONValue[];
    properties?: Record<string, JSONSchemaProperty>;
    required?: string[];
}

interface JSONSchema {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
}

export interface MCPRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: Record<string, JSONValue>;
}

export interface MCPResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: JSONValue };
}

export interface MCPTool {
    name: string;
    title?: string;
    description: string;
    inputSchema: JSONSchema;
    outputSchema?: JSONSchema;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ToolCallResult {
    content: [{ type: "text"; text: string }];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

export interface IPCMCPRequest {
    id: number;
    request: MCPRequest;
}

export interface TraceCapture {
    ts: number;
    type: string;
    data?: Record<string, unknown>;
}

interface TimedCapture {
    id: number;
    maxCaptures: number;
    startedAt: number;
    expiresAt: number;
    filter: RegExp | null;
}

export interface ActiveTrace extends TimedCapture {
    captures: TraceCapture[];
    unsub: (() => void) | null;
    isStoreTrace?: boolean;
    endedAt?: number;
}

export interface ModuleWatch extends TimedCapture {
    newModules: { ts: number; id: string; size: number; }[];
    baselineCount: number;
    listener: ((factory: unknown) => void) | null;
}

export interface InterceptCapture {
    ts: number;
    args: unknown[];
    result?: unknown;
    error?: string;
}

export interface FunctionIntercept extends Pick<TimedCapture, "id" | "maxCaptures" | "expiresAt"> {
    moduleId: string;
    exportKey: string;
    methodKey?: string;
    methodParent?: Record<string, unknown>;
    original: AnyFn;
    captures: InterceptCapture[];
    endedAt?: number;
}

export interface CacheEntry {
    result: unknown;
    expiresAt: number;
}

export interface ServerStats {
    requests: number;
    errors: number;
    startedAt: number;
    success: number;
    timeouts: number;
    pendingRequests?: number;
    queuedRequests?: number;
    uptimeFormatted?: string | null;
}

export interface SessionStats {
    requests: number;
    errors: number;
    initialized: boolean;
    clientInfo: string | null;
    connectedAt: number;
    toolCalls: number;
}

export interface ServerStatus {
    running: boolean;
    port: number;
    stats: ServerStats;
}

export interface BatchResult {
    count: number;
    moduleIds: string[];
    scannedTo: number;
}

type WebpackExportValue = JSONPrimitive | undefined | object | AnyFn;

export interface WebpackExport {
    displayName?: string;
    name?: string;
    prototype?: { render?: () => React.ReactNode };
    [key: string]: WebpackExportValue;
}

export interface WebpackModule {
    exports: WebpackExport;
    loaded?: boolean;
}

type FluxActionHandler = (event: FluxAction) => void;
type FluxInterceptor = (action: FluxAction) => boolean;

export interface FluxAction {
    type: string;
    [key: string]: JSONValue | undefined;
}

interface FluxHandlerNode<H> {
    name?: string;
    band?: number;
    actionHandler?: H;
    storeDidChange?: () => void;
}

type FluxDependencyNode = FluxHandlerNode<Record<string, FluxActionHandler>>;
type FluxOrderedHandler = FluxHandlerNode<FluxActionHandler>;

interface FluxActionHandlers {
    _dependencyGraph?: {
        nodes?: Record<string, FluxDependencyNode>;
        outgoingEdges?: Record<string, string[]>;
        incomingEdges?: Record<string, string[]>;
        circular?: Record<string, string[]>;
    };
    _orderedActionHandlers?: Record<string, FluxOrderedHandler[]>;
    getOrderedActionHandlers?: (action: { type: string }) => FluxOrderedHandler[];
}

export interface FluxDispatcherInternal {
    _actionHandlers?: FluxActionHandlers;
    _subscriptions?: Record<string, Set<FluxActionHandler>>;
    _interceptors?: FluxInterceptor[];
    addInterceptor?: (interceptor: FluxInterceptor) => void;
}

export interface DiscordAPIError {
    status?: number;
    httpStatus?: number;
    message?: string;
    body?: { code?: number; message?: string };
}

type HTTPMethod = "get" | "post" | "patch" | "put" | "del";

interface FiberType {
    displayName?: string;
    name?: string;
    render?: { displayName?: string };
    WrappedComponent?: { displayName?: string };
    _context?: { displayName?: string };
}

type FiberProps = Record<string, JSONValue | React.ReactNode | AnyFn>;

export interface FiberMemoizedState {
    tag?: number;
    create?: () => void | (() => void);
    queue?: { dispatch?: (action: JSONValue) => void; lastRenderedReducer?: { name?: string }; };
    memoizedState?: JSONValue | React.ReactNode;
    next?: FiberMemoizedState | null;
    deps?: ReadonlyArray<JSONValue> | null;
    current?: JSONValue;
}

export interface ReactFiber {
    tag: number;
    type?: FiberType;
    key: string | null;
    memoizedState?: FiberMemoizedState | null;
    memoizedProps?: FiberProps | null;
    stateNode?: { state?: Record<string, JSONValue>; forceUpdate?: () => void; } | null;
    return?: ReactFiber | null;
    child?: ReactFiber | null;
    sibling?: ReactFiber | null;
    _debugOwner?: ReactFiber | null;
    mode?: number;
}

export interface ComponentInfo {
    name: string | null;
    tagType: string;
    isMinified: boolean;
    key: string | null;
}

export interface FiberNode {
    name?: string;
    tagType: string;
    depth: number;
    propKeys?: string[];
    hasState?: boolean;
    minified?: boolean;
}

export interface TreeNode {
    tag: string;
    id?: string;
    classes?: string[];
    text?: string;
    children?: TreeNode[];
    moreChildren?: number;
}

export interface HookInfo {
    index: number;
    type: string;
    value?: unknown;
    deps?: number;
}

type ReplaceFn = (match: string, ...groups: string[]) => string;

export interface PluginReplacement {
    match?: string | RegExp;
    replace?: string | ReplaceFn;
    noWarn?: boolean;
    predicate?: () => boolean;
    fromBuild?: number;
    toBuild?: number;
}

export interface PluginPatch {
    find: string | RegExp;
    replacement: PluginReplacement | PluginReplacement[];
    all?: boolean;
    noWarn?: boolean;
    group?: boolean;
    predicate?: () => boolean;
    fromBuild?: number;
    toBuild?: number;
    plugin?: string;
}

export interface PluginSettings {
    enabled?: boolean;
    [key: string]: unknown;
}

export type PluginOption = PluginSettingDef;

export interface VencordPlugin {
    started?: boolean;
    required?: boolean;
    patches?: PluginPatch[];
    options?: Record<string, PluginOption>;
    settings?: { def?: Record<string, PluginOption>; store?: Record<string, unknown> };
}

export interface ToolError {
    error: true;
    message: string;
    suggestions?: string[];
}

export type ToolResult<T = Record<string, unknown>> = T | ToolError;

type ModuleAction = "find" | "extract" | "exports" | "context" | "diff" | "functionAt" | "structure" | "stats" | "loadLazy" | "watch" | "watchGet" | "watchStop" | "suggest" | "annotate" | "css" | "explain" | "genFinds";
type StoreAction = "find" | "list" | "state" | "call" | "snapshot" | "links";
type IntlAction = "hash" | "reverse" | "search" | "scan" | "targets" | "recover" | "clearCache";
type FluxToolAction = "events" | "dispatch" | "listeners" | "graph" | "producers" | "chain";
type GraphAction = "imports" | "importedBy" | "path" | "neighborhood" | "exports";
type PatchAction = "unique" | "analyze" | "plugin" | "lint" | "finds" | "conflicts" | "diff" | "broken" | "suggestFix" | "verifyApplied";

type FinderType = "byProps" | "byCode" | "store" | "componentByCode" | "exportedComponent" | "cssClasses" | "byClassNames";

export interface FinderSpec {
    type: FinderType;
    args: string[];
    plugin?: string;
}

export interface FinderResult extends FinderSpec {
    found: boolean;
    exportType?: string;
    error?: string;
}
type ReactAction = "query" | "styles" | "tree" | "path" | "fiber" | "props" | "hooks" | "contexts" | "find" | "state" | "source";
type DiscordAction = "orient" | "context" | "api" | "snowflake" | "endpoints" | "common" | "enum" | "constants" | "tokens" | "buildInfo" | "experiments";
type TraceAction = "start" | "get" | "stop" | "store";
type InterceptAction = "set" | "get" | "stop";
type PluginAction = "list" | "enable" | "disable" | "toggle" | "settings" | "setSetting";

interface ToolArgsBase<A> {
    action?: A;
    limit?: number;
}

interface CaptureWindowArgs {
    duration?: number;
    maxCaptures?: number;
}

export interface ModuleToolArgs extends ToolArgsBase<ModuleAction>, CaptureWindowArgs {
    id?: string;
    props?: string[];
    code?: string[];
    displayName?: string;
    className?: string;
    exportName?: string;
    exportValue?: string;
    pattern?: string;
    exact?: boolean;
    patched?: boolean;
    all?: boolean;
    maxLength?: number;
    chars?: number;
    filter?: string;
    watchId?: number;
    minScore?: number;
    requireUnique?: boolean;
}

export interface StoreToolArgs extends ToolArgsBase<StoreAction> {
    name?: string;
    method?: string;
    args?: unknown[];
}

export interface IntlToolArgs extends ToolArgsBase<IntlAction> {
    key?: string;
    hash?: string;
    query?: string;
    moduleId?: string;
}

export interface FluxToolArgs extends ToolArgsBase<FluxToolAction> {
    event?: string;
    type?: string;
    store?: string;
    payload?: Record<string, unknown>;
    filter?: string;
}

export interface GraphToolArgs extends ToolArgsBase<GraphAction> {
    id?: string;
    to?: string;
    depth?: number;
}

export interface ResolveToolArgs {
    landmark?: string;
    limit?: number;
}

export interface PatchToolArgs extends ToolArgsBase<PatchAction> {
    find?: string;
    match?: string;
    replace?: string;
    str?: string;
    id?: string;
    pluginName?: string;
    showNoMatch?: boolean;
    showMultiMatch?: boolean;
    showValid?: boolean;
    finders?: FinderSpec[];
}

export interface ReactToolArgs extends ToolArgsBase<ReactAction> {
    selector?: string;
    componentName?: string;
    properties?: string[];
    includeText?: boolean;
    includeByProps?: boolean;
    depth?: number;
    direction?: "up" | "down";
    includeProps?: boolean;
    breadth?: number;
}

export interface ConsoleToolArgs {
    action?: "recent" | "clear" | "stats";
    level?: "error" | "warn";
    limit?: number;
    sinceMs?: number;
}

export interface DiscordToolArgs {
    action?: DiscordAction;
    method?: HTTPMethod;
    endpoint?: string;
    body?: Record<string, unknown>;
    id?: string;
    filter?: string;
    memberName?: string;
}

export interface TraceToolArgs extends ToolArgsBase<TraceAction>, CaptureWindowArgs {
    id?: number;
    filter?: string;
    store?: string;
}

export interface InterceptToolArgs extends CaptureWindowArgs {
    action?: InterceptAction;
    id?: number;
    moduleId?: string;
    exportKey?: string;
}

export interface SearchToolArgs {
    limit?: number;
    pattern?: string;
    patterns?: string[];
    regex?: boolean;
}

export type TestPatchToolArgs = Pick<PatchToolArgs, "find" | "match" | "replace">;

export interface PluginToolArgs {
    action?: PluginAction;
    name?: string;
    showPatches?: boolean;
    validate?: boolean;
    setting?: string;
    value?: unknown;
}

export interface InitializeParams {
    protocolVersion?: string;
    clientInfo?: { name?: string; version?: string };
}

export interface ToolCallParams {
    name: string;
    arguments?: Record<string, JSONValue>;
}

export interface FoundComponent {
    name: string | null;
    selector: string;
    tagType: string;
    fiberDepth: number;
    matchedBy: "name" | "props";
    propKeys?: string[];
}

export interface CSSClassEntry {
    moduleId: string;
    key: string;
    semantic: string;
    hash: string;
}

export interface CSSModuleInfo {
    classCount: number;
    hash: string;
    classes: Record<string, string>;
}

export interface CSSIndexCache {
    index: Map<string, CSSClassEntry>;
    modules: Map<string, CSSModuleInfo>;
    builtAt: number;
}

export interface FindModuleMatch {
    id: string;
    snippet: string;
}

export interface SuggestCandidate {
    find: string;
    type: string;
    unique: boolean;
    moduleCount: number;
    intlKey?: string;
}

export interface AnchorCandidate {
    find: string;
    search: string;
    type: string;
    index: number;
}

export interface ModuleMatch {
    id: string;
    exports: unknown;
    key: string;
}

export interface AnchorInfo {
    anchor: string;
    type: string;
    unique: boolean;
    distance: number;
}

export interface RegexWarning {
    rule: string;
    severity: "error" | "warning" | "info";
    detail: string;
    location?: string;
}

export interface MatchDiagnostic {
    reason: string;
    partialMatch?: string;
    suggestion?: string;
}

export interface SnowflakeUtilsType {
    extractTimestamp(snowflake: string): number;
    isProbablyAValidSnowflake(value: string): boolean;
}

interface DesignTokenColor {
    css: string;
    resolve(ctx: { theme: string }): Record<string, unknown>;
}

export interface DesignTokens extends Record<"shadows" | "radii" | "spacing" | "modules" | "themes", Record<string, unknown>> {
    colors: Record<string, DesignTokenColor>;
    unsafe_rawColors: Record<string, DesignTokenColor>;
}
