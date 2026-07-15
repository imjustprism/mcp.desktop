# Managed Plugin APIs

The front door. Most plugin features attach through a managed API instead of a webpack patch. These APIs are build-stable by construction: no find, no match, no regex, nothing to repair when Discord rebuilds. Reach for the patch loop only when the feature reshapes render output no API exposes.

Every API here is grounded in `src/api` and wired in `src/utils/types.ts` (the `definePlugin` fields) and `src/api/PluginManager.ts` (the auto-added dependency). When a plugin sets one of these fields, PluginManager enables the backing API plugin for you. You can also import and call the raw function from `@api/...` for dynamic add/remove.

## Field vs raw function

Two ways to use each API:
- **Declarative field** on the `definePlugin({...})` object. PluginManager reads it, enables the dependency, and manages lifecycle. Prefer this.
- **Raw `add*`/`remove*`** call from `start()`/`stop()` when the attachment is dynamic or conditional. Then add the API plugin name to `dependencies` yourself.

## Message popover button

Adds a button to the message hover toolbar (reply, react, more).

| | |
|---|---|
| When | Per-message action triggered from the hover toolbar |
| Field | `messagePopoverButton: { key, label, icon, message, channel, onClick, ... }` |
| Raw | `addMessagePopoverButton(id, msg => data)` / `removeMessagePopoverButton(id)` from `@api/MessagePopover` |
| Dependency | `MessagePopoverAPI` |

## Message events

Intercept outgoing messages, edits, and clicks. Return `{ cancel: true }` from a pre-send/pre-edit listener to block the message.

| | |
|---|---|
| When | Rewrite, block, or inspect a message before it sends, or react to a message click |
| Field | `onBeforeMessageSend(channelId, msg, options, props)` / `onBeforeMessageEdit(channelId, messageId, msg)` / `onMessageClick(message, channel, event)` |
| Raw | `addMessagePreSendListener` / `addMessagePreEditListener` / `addMessageClickListener` (+ `remove*`) from `@api/MessageEvents` |
| Dependency | `MessageEventsAPI` |

## Context menus

Add, remove, or edit items in any Discord context menu, keyed by the menu's nav id (`"message"`, `"user-context"`, `"channel-context"`, ...).

| | |
|---|---|
| When | Add or rearrange a right-click menu item |
| Field | `contextMenus: { "message": (children, props) => { ... } }` |
| Raw | `addContextMenuPatch(navId, cb)` / `removeContextMenuPatch(navId, cb)` from `@api/ContextMenu` |
| Helper | `findGroupChildrenByChildId(id, children)` locates an existing group so you can splice next to a native item |
| Dependency | `ContextMenuAPI` |

## Flux events

Subscribe to Discord's own dispatcher. The `flux` field maps event names to handlers over `FluxDispatcher.subscribe`, with unsubscribe handled on plugin stop.

| | |
|---|---|
| When | React to a Discord action: `MESSAGE_CREATE`, `CHANNEL_SELECT`, `PRESENCE_UPDATES`, `RUNNING_GAMES_CHANGE`, ... |
| Field | `flux: { MESSAGE_CREATE(event) { ... } }` |
| Raw | `FluxDispatcher.subscribe(event, cb)` / `FluxDispatcher.unsubscribe(event, cb)` from `@webpack/common` |
| Dependency | none (dispatcher is always present) |

Read store state to answer "what is true now" and subscribe to Flux to answer "what just changed". See `references/runtime.md` for stores and `trace`.

## Slash commands

Register a chat command that shows in the `/` autocomplete.

| | |
|---|---|
| When | User-invoked command with typed options |
| Field | `commands: [{ name, description, options, execute }]` |
| Raw | `registerCommand(command, pluginName)` / `unregisterCommand(name)` from `@api/Commands` |
| Dependency | `CommandsAPI` |

## Chat bar button

Adds a button to the chat input bar next to the gift/gif/emoji buttons.

| | |
|---|---|
| When | Toggle or action anchored to the message composer |
| Field | `chatBarButton: { key, render }` |
| Raw | `addChatBarButton(id, render, icon)` / `removeChatBarButton(id)` from `@api/ChatButtons` |
| Dependency | `ChatInputButtonAPI` |

## Message accessories and decorations

Render your own component into a message without patching the message renderer.

| | |
|---|---|
| Below a message | `renderMessageAccessory` -> `MessageAccessoriesAPI` |
| Inline by the author name | `renderMessageDecoration` -> `MessageDecorationsAPI` |
| By a member list entry | `renderMemberListDecorator` -> `MemberListDecoratorsAPI` |

## Message updater

Force a message to re-render after you mutate it (for example after an accessory's data changes).

| | |
|---|---|
| When | Re-render a specific message you changed |
| Raw | `Vencord.Api.MessageUpdater` (`updateMessage`) |
| Dependency | `MessageUpdaterAPI` |

## Settings

Never patch settings UI. Declare settings and Equicord renders the config panel and persists values.

| | |
|---|---|
| When | Any plugin config, toggles, inputs, selects |
| Function | `definePluginSettings({ ... })` from `@api/Settings`, assigned to the `settings` field |
| Access | `settings.store.myKey` at runtime |

## When there is no API

Drop to the patch loop (SKILL.md quickstart) when the feature:
- injects JSX into a component Discord owns and no API surface reaches,
- gates or rewrites Discord's own render output,
- reads a prop or internal value that never reaches an API callback.

Even then, confirm no existing plugin already exposes the surface. Grep `src/plugins` and `src/equicordplugins` for the feature area before authoring a fresh patch, and reuse the helper rather than duplicating it.
