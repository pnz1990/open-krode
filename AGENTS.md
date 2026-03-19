# open-krode — AI Agent Context

## What This Is

An OpenCode plugin that adds a specialized `krode` agent for exploring and troubleshooting kro ResourceGraphDefinitions (RGDs) and their live instances. It opens a browser UI (like octto) with:

1. **DAG visualization mode** — renders the resource dependency graph for any RGD: nodes, edges, CEL expressions, includeWhen conditions, forEach fan-outs, specPatch state nodes.
2. **Live observability mode** — watches a live CR instance with 5-second auto-refresh: spec/status diff, Kubernetes events, readiness conditions, raw YAML.

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
│   ├── manager.ts        # SessionManager: create/end sessions, open/update/close views, watchers
│   ├── server.ts         # Bun HTTP+WebSocket server (one per session, random port)
│   ├── browser.ts        # Cross-platform browser opener
│   └── index.ts
├── tools/
│   └── index.ts          # MCP tools: open_krode_session, show_rgd_graph, list_rgd_instances,
│                         #   show_instance, show_instance_events, show_instance_yaml,
│                         #   close_krode_session
└── ui/
    ├── bundle.ts          # Self-contained HTML/CSS/JS UI (no dependencies)
    └── index.ts
```

## Tech Stack

- **Runtime**: Bun (HTTP + WebSocket server)
- **Language**: TypeScript (ES2022, strict)
- **Plugin SDK**: `@opencode-ai/plugin`
- **UI**: Vanilla HTML/CSS/JS with inline SVG DAG renderer
- **k8s access**: `kubectl` CLI (no in-cluster SDK — runs locally)

## Tools Summary

| Tool | What it does |
|---|---|
| `open_krode_session` | Opens browser UI, lists all RGDs from cluster |
| `show_rgd_graph` | Renders the DAG for an RGD in the browser |
| `list_rgd_instances` | Lists all live CR instances of an RGD |
| `show_instance` | Opens live view with 5s auto-refresh for a CR instance |
| `show_instance_events` | Shows Kubernetes events for a CR instance |
| `show_instance_yaml` | Shows raw YAML for a CR instance |
| `close_krode_session` | Closes browser + stops all watchers |

## Usage

### Install as OpenCode plugin

Add to `~/.config/opencode/opencode.json`:
```json
{
  "plugin": ["/Users/rrroizma/Projects/open-krode"]
}
```

Or build and publish to npm, then add:
```json
{
  "plugin": ["open-krode"]
}
```

### Use in OpenCode

Select the `krode` agent, then ask:
- "Show me the dungeon-graph RGD"
- "What's happening with the dungeon my-game in namespace rpg-system?"
- "Why isn't the boss resource being created in my dungeon?"
- "Explain the specPatch nodes in hero-graph"

### Build

```bash
bun install
bun run build   # outputs to dist/
```

## Development Rules

- **Never run locally** — the plugin is loaded by OpenCode; the Bun server starts on demand when a session is opened
- **kubectl context**: always pass `kubectl_context` when working with a specific cluster; defaults to current context
- **No game logic** — this plugin is generic kro, not krombat-specific
- **Browser UI is self-contained** — `src/ui/bundle.ts` exports a single HTML string; no build step for the UI, no external CDN dependencies
- **WebSocket reconnects automatically** — the UI retries every 2s on disconnect

## Key Design Decisions

1. **One HTTP+WS server per session** (port 0 = OS-assigned) — same pattern as octto, avoids port conflicts
2. **Views are multiplexed over one WS connection** — `view.open/update/close` messages let the agent manage multiple panels simultaneously
3. **Live watchers** — `startWatcher` uses `setInterval` in the plugin process; pushes updates over WS. Cleaned up on `endSession` or `close_krode_session`.
4. **DAG layout is BFS-layered** — pure JS, no D3 or force simulation. Deterministic and fast.
5. **Conditions use `status.conditions` array** — kro follows standard K8s condition conventions.
