# open-krode

An [OpenCode](https://opencode.ai) plugin that adds a specialized `krode` agent for exploring and troubleshooting [kro](https://kro.run) ResourceGraphDefinitions (RGDs) and their live instances — directly in your browser.

## What it does

- **DAG visualization** — renders the full resource dependency graph for any RGD: nodes, edges, CEL expressions, `includeWhen` conditions, `forEach` fan-outs, `specPatch` state nodes. Click any node or edge to inspect its CEL and concept explanation.
- **Live observability** — watches a live CR instance with 5-second auto-refresh: spec/status diff, Kubernetes events, readiness conditions, live YAML.
- **Deep instance graph** — recursively expands sub-RGDs, forEach instances, and all child resources up to 4 levels deep. Click any node to see its live YAML.

## Installation

### From npm (recommended)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["open-krode"]
}
```

OpenCode will install it automatically via Bun on next startup. No separate `npm install` needed.

### From local path (development)

```json
{
  "plugin": ["/path/to/open-krode"]
}
```

## Requirements

- [OpenCode](https://opencode.ai) with plugin support
- `kubectl` configured with access to a cluster running [kro](https://kro.run)
- A browser (opens automatically)

## Usage

Select the **`krode`** agent in OpenCode, then ask things like:

- *"Show me the my-app-graph RGD"*
- *"What instances of my-app-graph exist in namespace prod?"*
- *"Why isn't the database resource being created?"*
- *"Explain the specPatch nodes in my-app-graph"*
- *"Open a deep view for instance my-app in namespace default"*

## Tools

| Tool | Description |
|---|---|
| `open_krode_session` | Opens the browser UI and lists all RGDs from the cluster |
| `show_rgd_graph` | Renders the DAG for an RGD in the browser |
| `list_rgd_instances` | Lists all live CR instances of an RGD |
| `show_instance` | Opens a live view with 5s auto-refresh for a CR instance |
| `show_deep_instance` | Opens the full multi-level instance graph |
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
│   ├── types.ts          # KrodeSession, View, ViewMode, cache types
│   ├── manager.ts        # SessionManager: create/end sessions, views, watchers
│   ├── server.ts         # Bun HTTP+WebSocket server (one per session, random port)
│   ├── browser.ts        # Cross-platform browser opener
│   └── index.ts
├── tools/
│   └── index.ts          # MCP tool definitions
└── ui/
    └── bundle.ts         # Self-contained HTML/CSS/JS UI (no external dependencies)
```

## Tech stack

- **Runtime**: [Bun](https://bun.sh) (HTTP + WebSocket server)
- **Language**: TypeScript 5 (strict)
- **Plugin SDK**: `@opencode-ai/plugin`
- **UI**: Vanilla HTML/CSS/JS with inline SVG DAG renderer — no external dependencies, no build step for the UI
- **k8s access**: `kubectl` CLI — runs from your local kubeconfig, no in-cluster SDK

## Development

```bash
bun install
bun run build           # build dist/index.js + write dist/ui.html
bun run typecheck       # type-check without emitting
bun run install:plugin  # build + copy to ~/.cache/opencode for local testing
```

UI changes (`src/ui/bundle.ts`) only need `bun run build` + browser refresh — no OpenCode restart required.

Logic changes (anything else in `src/`) require an OpenCode restart after `bun run install:plugin`.

## License

MIT
