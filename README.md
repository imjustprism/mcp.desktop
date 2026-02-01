# mcp.desktop

Cute little plugin that exposes discord webpack to mcp. Works with Equicord and Vencord.

Your ai can search webpack modules, test patches, trace flux actions, mess with stores, whatever you need.

## Setup

First clone equicord or vencord:

```bash
git clone https://github.com/Equicord/Equicord.git
```

or

```bash
git clone https://github.com/Vendicated/Vencord.git
```

Then install dependencies:

```bash
cd Equicord # or Vencord
pnpm install --frozen-lockfile
```

Clone this plugin into userplugins:

```bash
cd src/userplugins
git clone https://github.com/imjustprism/mcp.desktop
```

Build and inject:

```bash
pnpm build --dev
pnpm inject
pnpm watch
```

## Connecting your ai

The plugin runs an mcp server on `localhost:8486`. How you add it depends on what ai you use.

Check your ai's docs for adding local mcp servers. Point it at `http://localhost:8486`.

Note: sometimes the ai won't see the server. Launch discord first to start the server, then open your ai chat session.
