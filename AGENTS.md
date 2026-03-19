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

## Plugin Installation & Development Workflow

**CRITICAL — read this before touching the plugin or telling the user to restart.**

### How OpenCode loads this plugin

`~/.config/opencode/opencode.json` currently uses the **local path** (already switched):
```json
{
  "plugin": ["@different-ai/opencode-browser", "/Users/rrroizma/Projects/open-krode"]
}
```
OpenCode loads the plugin once at startup from `dist/index.js` into memory. The JS bundle itself is immutable for the lifetime of the process.

### UI hot-reload (implemented — no restart needed for UI changes)

`src/session/server.ts` was changed to **read `dist/ui.html` from disk on every `GET /`** instead of caching the HTML at startup.

`bun run build` now also runs `scripts/write-ui-html.ts` which writes the rendered HTML to `dist/ui.html`.

**Dev workflow for UI-only changes:**
1. Edit `src/ui/bundle.ts`
2. `bun run build` — rebuilds `dist/index.js` + writes `dist/ui.html`
3. Browser refresh — done. No OpenCode restart needed.

**When a restart IS still required:**
- Changes to any non-UI TypeScript (tools, session manager, kubectl, server logic)
- After the very first time you apply the hot-reload patch (one-time bootstrap)

### Correct update workflow for logic changes

1. Make code changes
2. `bun run build`
3. Fully quit and restart OpenCode (kill all `opencode` processes)
4. Verify in the browser: topbar should show `v0.2.0 · <build time>` and `class="ctx-badge"` (not the old `class="ctx"`)

### Diagnosing stale UI

Check what the running server is actually serving:
```bash
curl -s http://localhost:<PORT>/ | grep -o 'ctx-badge\|class="ctx"\|v0\.[0-9]'
```
- `ctx-badge` + version stamp → latest build is live
- `class="ctx"` or no version → stale in-memory bundle, OpenCode needs restart

The old CSS used `class="ctx"` and `id="ctx"`. The current code uses `class="ctx-badge"` and `id="ctx-badge"`. This is the canonical staleness indicator.

### Known past bug (fixed in commit 8d1edb5)

`import.meta.dir` is Bun-specific and is `undefined` when OpenCode loads the plugin via Node.js. This caused `readFileSync` to silently fail and fall back to `getHtmlBundle()` (the in-memory bundle), making hot-reload appear broken even after a restart.

The fix in `server.ts`:
```ts
const _metaDir: string =
  (import.meta as { dir?: string }).dir ??
  (() => {
    const { fileURLToPath } = require("node:url");
    return join(fileURLToPath(import.meta.url), "..");
  })();
```
This is committed and pushed. If hot-reload is still not working after a restart, check this code is present in `dist/index.js`:
```bash
grep 'fileURLToPath' /Users/rrroizma/Projects/open-krode/dist/index.js
```
If missing: run `bun run build` then restart OpenCode.

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
6. **UI hot-reload via `dist/ui.html`** — `scripts/write-ui-html.ts` writes the rendered HTML bundle to `dist/ui.html` at build time. `server.ts` reads this file from disk on every `GET /` request (with in-process fallback). This means UI-only changes only need `bun run build` + browser refresh — no OpenCode restart.

---

## Copy-paste prompt for next session

Use this at the start of a new OpenCode session to restore context:

```
We are working on open-krode: an OpenCode plugin at /Users/rrroizma/Projects/open-krode.

Key context:
- Plugin is loaded by OpenCode from the local path (not npm). Config: ~/.config/opencode/opencode.json has "plugin": ["@different-ai/opencode-browser", "/Users/rrroizma/Projects/open-krode"]
- OpenCode loads dist/index.js into memory at startup. Non-UI logic changes require a full OpenCode restart.
- UI hot-reload IS implemented: server.ts reads dist/ui.html from disk on every GET /. So UI-only changes (src/ui/bundle.ts) only need `bun run build` + browser refresh — no restart.
- Build command: `bun run build` — rebuilds dist/index.js AND writes dist/ui.html via scripts/write-ui-html.ts
- Staleness check: `curl -s http://localhost:<PORT>/ | grep -o 'ctx-badge\|class="ctx"\|v0\.[0-9]'`
  - ctx-badge + version stamp = fresh
  - class="ctx" = stale in-memory bundle (OpenCode needs restart)
- Version stamp in topbar: "v0.2.0 · <build time UTC>" — missing or __VERSION_STAMP__ means stale

## MANDATORY: Verify the UI before doing any work

Run these steps AT THE START of every session, in order. Do not skip or assume anything.

### Step 1 — Check the build is current
```bash
grep 'fileURLToPath' /Users/rrroizma/Projects/open-krode/dist/index.js
```
- If output is empty: run `bun run build` first. The hot-reload fix is missing from dist/.

### Step 2 — Check process start time vs build time
```bash
ps aux | grep opencode | grep -v grep
ls -la /Users/rrroizma/Projects/open-krode/dist/index.js
```
- If OpenCode started BEFORE dist/index.js was last modified: OpenCode has stale code in memory. A restart is required.
- If OpenCode started AFTER dist/index.js was last modified: hot-reload should work — no restart needed.

### Step 3 — Open a session and curl the served port
```bash
# after open_krode_session returns the port:
curl -s http://localhost:<PORT>/ | grep -o 'ctx-badge\|class="ctx"\|v0\.[0-9]'
```
- `ctx-badge` = fresh. Proceed.
- `class="ctx"` = stale. Do NOT just say "restart OpenCode". First re-check Steps 1 and 2 to understand WHY it's stale before acting.

### What NOT to do
- Do NOT blindly tell the user to restart OpenCode without first diagnosing why the UI is stale.
- Do NOT assume a restart will fix it if we've already restarted once this session.
- If stale after a confirmed restart: the fix in dist/index.js is likely missing or wrong. Check `grep 'fileURLToPath' dist/index.js` and re-read server.ts.
```
