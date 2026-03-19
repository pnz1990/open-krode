# open-krode

An [OpenCode](https://opencode.ai) plugin that adds a specialized `krode` agent for exploring and troubleshooting [kro](https://kro.run) ResourceGraphDefinitions (RGDs) and their live instances.

It opens a browser UI with:

- **DAG visualization** — renders the full resource dependency graph for any RGD: nodes, edges, CEL expressions, `includeWhen` conditions, `forEach` fan-outs, `specPatch` state nodes.
- **Live observability** — watches a live CR instance with 5-second auto-refresh: spec/status diff, Kubernetes events, readiness conditions, raw YAML.

## Installation

Add the plugin to your OpenCode config at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/path/to/open-krode"]
}
```

Or after publishing to npm:

```json
{
  "plugin": ["open-krode"]
}
```

## Usage

Select the `krode` agent in OpenCode, then ask things like:

- "Show me the dungeon-graph RGD"
- "What's happening with the dungeon my-game in namespace rpg-system?"
- "Why isn't the boss resource being created in my dungeon?"
- "Explain the specPatch nodes in hero-graph"

## Tools

| Tool | Description |
|---|---|
| `open_krode_session` | Opens the browser UI and lists all RGDs from the cluster |
| `show_rgd_graph` | Renders the DAG for an RGD in the browser |
| `list_rgd_instances` | Lists all live CR instances of an RGD |
| `show_instance` | Opens a live view with 5s auto-refresh for a CR instance |
| `show_instance_events` | Shows Kubernetes events for a CR instance |
| `show_instance_yaml` | Shows raw YAML for a CR instance |
| `close_krode_session` | Closes the browser and stops all watchers |

## Architecture

```
src/
├── index.ts              # Plugin entry point — registers tools + krode agent config
├── agent/
│   └── prompt.ts         # System prompt for the krode agent
├── kro/
│   ├── types.ts          # RGD/instance/graph TypeScript types
│   ├── kubectl.ts        # kubectl wrappers: listRGDs, getInstance, buildRGDGraph, etc.
│   └── index.ts
├── session/
│   ├── types.ts          # KrodeSession, View, ViewMode, WS message types
│   ├── manager.ts        # SessionManager: create/end sessions, views, watchers
│   ├── server.ts         # Bun HTTP+WebSocket server (one per session, random port)
│   ├── browser.ts        # Cross-platform browser opener
│   └── index.ts
├── tools/
│   └── index.ts          # MCP tool definitions
└── ui/
    └── bundle.ts         # Self-contained HTML/CSS/JS UI (no dependencies)
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) (HTTP + WebSocket server)
- **Language**: TypeScript 5 (ES2022, strict)
- **Plugin SDK**: `@opencode-ai/plugin`
- **UI**: Vanilla HTML/CSS/JS with inline SVG DAG renderer — no external dependencies
- **k8s access**: `kubectl` CLI (no in-cluster SDK — runs locally)

## Development

```bash
bun install
bun run build          # outputs to dist/
bun run typecheck      # type-check without emitting
bun run install:plugin # build + copy to ~/.cache/opencode for local testing
```

The plugin is loaded by OpenCode — the Bun HTTP+WS server starts on demand when a session is opened.

## Requirements

- [Bun](https://bun.sh) v1.x
- `kubectl` configured with access to a kro cluster
- [OpenCode](https://opencode.ai) with plugin support
