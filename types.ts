/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginOptionsItem } from "@utils/types";
import type { FluxStore } from "@vencord/discord-types";

export type JSONPrimitive = string | number | boolean | null;
export type JSONObject = { [key: string]: JSONValue };
export type JSONValue = JSONPrimitive | JSONValue[] | JSONObject;

export type JSONSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface JSONSchemaProperty {
    type: JSONSchemaType;
    description?: string;
    default?: JSONValue;
    items?: JSONSchemaProperty;
    enum?: JSONValue[];
    properties?: Record<string, JSONSchemaProperty>;
    required?: string[];
}

export interface JSONSchema {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
}

interface MCPBase {
    jsonrpc: "2.0";
    id: number | string | null;
}

export interface MCPRequest extends MCPBase {
    id: number | string;
    method: string;
    params?: Record<string, JSONValue>;
}

export interface MCPError {
    code: number;
    message: string;
    data?: JSONValue;
}

export interface MCPResponse extends MCPBase {
    result?: unknown;
    error?: MCPError;
}

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: JSONSchema;
}

export interface ToolCallResult {
    content: [{ type: "text"; text: string }];
    isError?: boolean;
}

export interface IPCMCPRequest {
    id: number;
    request: MCPRequest;
}

interface Timestamped {
    ts: number;
}

interface ExpiringResource {
    id: number;
    maxCaptures: number;
    startedAt: number;
    expiresAt: number;
}

interface FilterableResource {
    filter: RegExp | null;
}

export interface TraceCapture extends Timestamped {
    type: string;
    data?: Record<string, unknown>;
}

export interface ActiveTrace extends ExpiringResource, FilterableResource {
    captures: TraceCapture[];
    unsub: (() => void) | null;
    isStoreTrace?: boolean;
}

export interface WatchedModule extends Timestamped {
    id: string;
    size: number;
}

export interface ModuleWatch extends ExpiringResource, FilterableResource {
    newModules: WatchedModule[];
    baselineCount: number;
    listener: ((factory: unknown) => void) | null;
}

export interface InterceptCapture extends Timestamped {
    args: unknown[];
    result?: unknown;
    error?: string;
}

export interface FunctionIntercept extends Omit<ExpiringResource, "startedAt"> {
    moduleId: string;
    exportKey: string;
    original: (...args: unknown[]) => unknown;
    captures: InterceptCapture[];
}

export interface CacheEntry {
    result: unknown;
    expiresAt: number;
}

interface BaseStats {
    requests: number;
    errors: number;
}

export interface ServerStats extends BaseStats {
    startedAt: number;
    success: number;
    timeouts: number;
    pendingRequests?: number;
    queuedRequests?: number;
    uptimeFormatted?: string | null;
}

export interface SessionStats extends BaseStats {
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
}

type WebpackExportValue = string | number | boolean | null | undefined | object | ((...args: unknown[]) => unknown);

export interface WebpackExport {
    displayName?: string;
    name?: string;
    prototype?: { render?: () => React.ReactNode };
    [key: string]: WebpackExportValue;
}

export interface WebpackModule {
    exports: WebpackExport;
}

export type WebpackModuleFactory = (module: WebpackModule, exports: WebpackExport, require: WebpackRequire) => void;

export interface WebpackRequire {
    m: Record<string, WebpackModuleFactory>;
    c: Record<string, WebpackModule>;
}

export type FluxActionHandler = (event: FluxAction) => void;
export type FluxInterceptor = (action: FluxAction) => boolean;

export interface FluxAction {
    type: string;
    [key: string]: JSONValue | undefined;
}

interface FluxHandlerBase {
    name?: string;
    actionHandler?: Record<string, FluxActionHandler> | FluxActionHandler;
    storeDidChange?: () => void;
}

export interface FluxDependencyNode extends FluxHandlerBase {
    actionHandler?: Record<string, FluxActionHandler>;
}

export interface FluxOrderedHandler extends FluxHandlerBase {
    actionHandler?: FluxActionHandler;
}

export interface FluxDependencyGraph {
    nodes?: Record<string, FluxDependencyNode>;
}

export interface FluxActionHandlers {
    _dependencyGraph?: FluxDependencyGraph;
    _orderedActionHandlers?: Record<string, FluxOrderedHandler[]>;
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

export type HTTPMethod = "get" | "post" | "patch" | "put" | "del";

export interface GatewaySocket {
    connectionState_: string;
    sessionId: string | null;
    seq: number;
    heartbeatInterval: number;
    heartbeatAck: boolean;
    lastHeartbeatTime: number;
    lastHeartbeatAckTime: number;
    connectionStartTime: number;
    identifyCount: number;
    resumeUrl: string | null;
}

export interface StoreWithListeners extends FluxStore {
    addChangeListener: (handler: () => void) => void;
    removeChangeListener: (handler: () => void) => void;
}

interface DisplayNameable {
    displayName?: string;
}

export interface FiberType extends DisplayNameable {
    name?: string;
    render?: DisplayNameable;
    WrappedComponent?: DisplayNameable;
    _context?: DisplayNameable;
}

export type FiberTag = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27;

export type FiberProps = Record<string, JSONValue | React.ReactNode | ((...args: unknown[]) => unknown)>;

export interface FiberStateNode {
    state?: Record<string, JSONValue>;
    forceUpdate?: () => void;
}

export interface FiberStateQueue {
    dispatch?: (action: JSONValue) => void;
    lastRenderedReducer?: { name?: string };
}

export interface FiberMemoizedState {
    tag?: number;
    create?: () => void | (() => void);
    queue?: FiberStateQueue;
    memoizedState?: JSONValue | React.ReactNode;
    next?: FiberMemoizedState | null;
    deps?: ReadonlyArray<JSONValue> | null;
    current?: JSONValue;
}

export interface ReactFiber {
    tag: FiberTag;
    type?: FiberType;
    key: string | null;
    memoizedState?: FiberMemoizedState | null;
    memoizedProps?: FiberProps | null;
    stateNode?: FiberStateNode | null;
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

export type ReplaceFn = (match: string, ...groups: string[]) => string;

export interface PluginReplacement {
    match?: string | RegExp;
    replace?: string | ReplaceFn;
}

export interface PluginPatch {
    find: string | RegExp;
    replacement: PluginReplacement | PluginReplacement[];
}

export interface PluginSettings {
    enabled?: boolean;
    [key: string]: unknown;
}

export type PluginOption = PluginOptionsItem;

export interface VencordPlugin {
    started?: boolean;
    required?: boolean;
    patches?: PluginPatch[];
    options?: Record<string, PluginOption>;
}

export interface PluginManagerAPI {
    startPlugin: (plugin: unknown) => boolean;
    stopPlugin: (plugin: unknown) => boolean;
}

export interface ToolError {
    error: true;
    message: string;
    suggestions?: string[];
}

export type ToolResult<T = Record<string, unknown>> = T | ToolError;

export function isToolError(result: ToolResult): result is ToolError {
    return typeof result === "object" && result !== null && "error" in result && result.error === true;
}

type ModuleAction = "find" | "extract" | "exports" | "context" | "diff" | "deps" | "size" | "ids" | "stats" | "loadLazy" | "watch" | "watchGet" | "watchStop";
type StoreAction = "find" | "list" | "state" | "call" | "subscriptions" | "methods";
type IntlAction = "hash" | "reverse" | "search" | "scan" | "targets" | "bruteforce" | "test";
type FluxAction_ = "events" | "types" | "dispatch" | "listeners";
type PatchAction = "unique" | "analyze" | "plugin" | "lint";
type ReactAction = "query" | "styles" | "modify" | "tree" | "text" | "path" | "fiber" | "props" | "hooks" | "contexts" | "find" | "forceUpdate" | "state" | "owner" | "root";
type DiscordAction = "context" | "api" | "snowflake" | "endpoints" | "common" | "enum" | "memory" | "performance" | "gateway" | "waitForIpc";
type TraceAction = "events" | "handlers" | "storeEvents" | "start" | "get" | "stop" | "store";
type InterceptAction = "set" | "get" | "stop";
type PluginAction = "list" | "enable" | "disable" | "toggle" | "settings" | "setSetting";

interface BaseToolArgs {
    limit?: number;
}

export interface ModuleToolArgs extends BaseToolArgs {
    action?: ModuleAction;
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
    duration?: number;
    maxCaptures?: number;
    filter?: string;
    watchId?: number;
}

export interface StoreToolArgs extends BaseToolArgs {
    action?: StoreAction;
    name?: string;
    method?: string;
    args?: unknown[];
    depth?: number;
    includeTypes?: boolean;
}

export interface IntlToolArgs extends BaseToolArgs {
    action?: IntlAction;
    key?: string;
    hash?: string;
    hashes?: string[];
    query?: string;
    moduleId?: string;
    candidates?: string[];
    prefixes?: string[];
    suffixes?: string[];
    mids?: string[];
    pattern?: string;
    parts?: Record<string, string[]>;
}

export interface FluxToolArgs {
    action?: FluxAction_;
    event?: string;
    type?: string;
    payload?: Record<string, unknown>;
    filter?: string;
}

export interface PatchToolArgs extends BaseToolArgs {
    action?: PatchAction;
    find?: string;
    match?: string;
    replace?: string;
    str?: string;
    pluginName?: string;
    showNoMatch?: boolean;
    showMultiMatch?: boolean;
    showValid?: boolean;
}

export interface ReactToolArgs extends BaseToolArgs {
    action?: ReactAction;
    selector?: string;
    componentName?: string;
    properties?: string[];
    styles?: Record<string, string>;
    addClass?: string;
    removeClass?: string;
    setAttribute?: Record<string, string>;
    includeText?: boolean;
    includeByProps?: boolean;
    depth?: number;
    direction?: "up" | "down";
    includeProps?: boolean;
    breadth?: number;
}

export interface DiscordToolArgs {
    action?: DiscordAction;
    method?: HTTPMethod;
    endpoint?: string;
    body?: Record<string, unknown>;
    id?: string;
    filter?: string;
    memberName?: string;
    timeout?: number;
}

export interface TraceToolArgs extends BaseToolArgs {
    action?: TraceAction;
    id?: number;
    filter?: string;
    event?: string;
    store?: string;
    duration?: number;
    maxCaptures?: number;
}

export interface InterceptToolArgs {
    action?: InterceptAction;
    id?: number;
    moduleId?: string;
    exportKey?: string;
    duration?: number;
    maxCaptures?: number;
}

export interface SearchToolArgs extends BaseToolArgs {
    pattern?: string;
    regex?: boolean;
}

export interface TestPatchToolArgs {
    find?: string;
    match?: string;
    replace?: string;
}

export interface PluginToolArgs {
    action?: PluginAction;
    name?: string;
    showPatches?: boolean;
    validate?: boolean;
    setting?: string;
    value?: unknown;
}

export interface EvaluateCodeArgs {
    code?: string;
}

export type ToolArgs =
    | ModuleToolArgs
    | StoreToolArgs
    | IntlToolArgs
    | FluxToolArgs
    | PatchToolArgs
    | ReactToolArgs
    | DiscordToolArgs
    | TraceToolArgs
    | InterceptToolArgs
    | SearchToolArgs
    | TestPatchToolArgs
    | PluginToolArgs
    | EvaluateCodeArgs;

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
