# open-krode — AI Agent Context

## What This Is

An OpenCode plugin that adds a specialized `krode` agent for exploring and troubleshooting kro ResourceGraphDefinitions (RGDs) and their live instances. It opens a browser UI with:

1. **DAG visualization mode** — renders the resource dependency graph for any RGD: nodes, edges, CEL expressions, includeWhen conditions, forEach fan-outs, externalRef nodes.
2. **Live observability mode** — watches a live CR instance with 5-second auto-refresh: spec/status diff, Kubernetes events, readiness conditions, raw YAML.
3. **Deep instance graph** — recursively expands forEach instances and child resources up to 4 levels.

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
│   ├── types.ts          # KrodeSession, View, ViewMode, KrodeCache types
│   ├── manager.ts        # SessionManager: create/end sessions, open/update/close views, watchers
│   ├── server.ts         # Bun HTTP+WebSocket server (one per session, random port)
│   ├── browser.ts        # Cross-platform browser opener
│   └── index.ts
├── tools/
│   └── index.ts          # MCP tools
└── ui/
    └── bundle.ts          # Self-contained HTML/CSS/JS UI (no dependencies)
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
| `show_deep_instance` | Opens multi-level instance graph |
| `show_instance_events` | Shows Kubernetes events for a CR instance |
| `show_instance_yaml` | Shows raw YAML for a CR instance |
| `close_krode_session` | Closes browser + stops all watchers |

## Plugin Installation & Development Workflow

**CRITICAL — read this before touching the plugin or telling the user to restart.**

### How OpenCode loads this plugin

The local path in `opencode.json` causes OpenCode to load the plugin as a **local npm package** — it reads `package.json` → `exports` → loads `dist/index.js` directly from the project directory.

OpenCode loads `dist/index.js` **once at startup** and holds it in memory. The JS bundle is immutable for the lifetime of the process.

**There must be NO file at `~/.config/opencode/plugins/open-krode.ts`** — if that file exists it shadows the cache and serves old HTML. Verify with:
```bash
ls ~/.config/opencode/plugins/
```
If `open-krode.ts` appears there, delete it immediately.

### UI hot-reload (no restart needed for UI changes)

`src/session/server.ts` reads **`dist/ui.html` from disk on every `GET /`** instead of caching the HTML at startup.

**Dev workflow for UI-only changes:**
1. Edit `src/ui/bundle.ts`
2. `bun run build` — rebuilds `dist/index.js` + writes `dist/ui.html`
3. Browser refresh — done. No OpenCode restart needed.

**When a restart IS still required:**
- Changes to any non-UI TypeScript (tools, session manager, kubectl, server logic)

### Correct update workflow for logic changes

1. Make code changes
2. `bun run install:plugin` — builds + copies `dist/index.js`, `dist/ui.html`, and `package.json` to `~/.cache/opencode/node_modules/@pnz1990/open-krode/dist/`
3. Fully quit and restart OpenCode (kill all `opencode` processes)
4. Verify in the browser: topbar should show `v0.2.0 · <build time>` and `class="ctx-badge"`

**Note**: The plugin is published to npm as `@pnz1990/open-krode`. The global
OpenCode config (`~/.config/opencode/opencode.json`) uses the npm package.
Local development overrides this via `bun run install:plugin` which writes
directly to the npm package cache.

### Diagnosing stale UI

```bash
curl -s http://localhost:<PORT>/ | grep -o 'ctx-badge\|class="ctx"\|v0\.[0-9]'
```
- `ctx-badge` + version stamp → latest build is live
- `class="ctx"` → stale; diagnose before restarting

## Development Rules

- **Never run locally** — the plugin is loaded by OpenCode; the Bun server starts on demand when a session is opened
- **kubectl context**: always pass `kubectl_context` when working with a specific cluster; defaults to current context
- **Browser UI is self-contained** — `src/ui/bundle.ts` exports a single HTML string; no external CDN dependencies
- **WebSocket reconnects automatically** — the UI retries every 2s on disconnect
- **KRO_CONCEPTS** is injected as `JSON.stringify` at build time to avoid quote escaping issues in the inline `<script>` block

## Upstream kro Alignment (IMPORTANT)

Only represent features from **`kubernetes-sigs/kro`** (upstream).
Fork-specific concepts that must NEVER appear: `specPatch`, `stateFields`,
`GraphRevision` CRD. See `src/agent/prompt.ts` for the full upstream concept list.

**Five real upstream node types** (`pkg/graph/node.go`):
- `NodeTypeInstance` → kind `"root"` (root CR, CEL variable: `schema`)
- `NodeTypeResource` → kind `"resource"` (template, no forEach)
- `NodeTypeCollection` → kind `"collection"` (template + forEach)
- `NodeTypeExternal` → kind `"external"` (externalRef by name)
- `NodeTypeExternalCollection` → kind `"externalCollection"` (externalRef by selector)

`includeWhen` is a modifier (`isConditional: true`), not a node type.

## Key Design Decisions

1. **One HTTP+WS server per session** (port 0 = OS-assigned) — avoids port conflicts
2. **Views are multiplexed over one WS connection** — `view.open/update/close` messages let the agent manage multiple panels simultaneously
3. **Session cache** — `KrodeCache` (TTL map) on the session object caches RGD list (30s), RGD details (60s), and resource YAML (10s, failures not cached). Warmed on WS connect.
4. **Live watchers** — `setInterval` in the plugin process; pushes updates over WS. Cleared on WS disconnect, restarted on reconnect via `restartWatchers()`. Stable viewIds prevent watcher leaks.
5. **DAG layout is BFS-layered** — pure JS, no D3 or force simulation. Deterministic and fast.
6. **UI hot-reload via `dist/ui.html`** — read from disk on every `GET /`. Build + browser refresh, no OpenCode restart needed for UI changes.
