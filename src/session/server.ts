import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { getHtmlBundle } from "@/ui/bundle";
import {
  getResourceYaml, listInstances, listRGDs, getRGDDetail, buildRGDGraph,
  buildDeepInstanceGraph, getInstance, getInstanceEvents, getChildResources,
  detectReconciling, buildNodeLiveStates,
} from "@/kro";
import type { KrodeCache, KrodeSession, SessionId } from "./types";
import type { RGDDetail, RGDSummary } from "@/kro/types";

interface WsData {
  sessionId: SessionId;
}

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

// Cache TTLs
const TTL_RGD_LIST   = 30_000;  // 30s — RGDs rarely change
const TTL_RGD_DETAIL = 60_000;  // 60s — RGD spec is static between deploys
const TTL_YAML       = 10_000;  // 10s — live resource YAML

// Resolve the path to dist/ui.html relative to this file's location.
// import.meta.dir is Bun-specific; fall back to import.meta.url for Node.js compatibility.
const _metaDir: string =
  (import.meta as { dir?: string }).dir ??
  (() => {
    const { fileURLToPath } = require("node:url") as { fileURLToPath: (u: string) => string };
    return join(fileURLToPath(import.meta.url), "..");
  })();
const UI_HTML_PATH  = join(_metaDir, "ui.html");
const LOGO_PATH     = join(_metaDir, "logo.png");
const FAVICON_PATH  = join(_metaDir, "favicon.png");

function serveHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf-8");
  } catch {
    return getHtmlBundle();
  }
}

function serveImage(path: string, contentType: string): Response {
  try {
    const data = readFileSync(path);
    return new Response(data, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" } });
  } catch {
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  }
}

// ─── Cached kubectl wrappers ──────────────────────────────────────────────────

async function cachedListRGDs(cache: KrodeCache, context?: string): Promise<RGDSummary[]> {
  const key = `rgds:${context ?? ""}`;
  const hit = cache.get<RGDSummary[]>(key);
  if (hit) return hit;
  const result = await listRGDs(context);
  cache.set(key, result, TTL_RGD_LIST);
  return result;
}

async function cachedGetRGDDetail(cache: KrodeCache, name: string, context?: string): Promise<RGDDetail> {
  const key = `rgd:${name}:${context ?? ""}`;
  const hit = cache.get<RGDDetail>(key);
  if (hit) return hit;
  const result = await getRGDDetail(name, context);
  cache.set(key, result, TTL_RGD_DETAIL);
  return result;
}

async function cachedGetResourceYaml(cache: KrodeCache, namespace: string, kind: string, name: string, context?: string): Promise<string> {
  const key = `yaml:${namespace}:${kind}:${name}:${context ?? ""}`;
  const hit = cache.get<string>(key);
  if (hit !== undefined) return hit;
  const result = await getResourceYaml(namespace, kind, name, context);
  cache.set(key, result, TTL_YAML);
  return result;
}

// ─── Background cache warm-up ─────────────────────────────────────────────────
// Called once per WS connect. Fetches the RGD list + all RGD details in
// parallel so they're ready before the user clicks anything.

async function warmCache(cache: KrodeCache, context?: string): Promise<void> {
  try {
    const rgds = await cachedListRGDs(cache, context);
    // Fetch all RGD details in parallel — they're small and static
    await Promise.allSettled(rgds.map(r => cachedGetRGDDetail(cache, r.name, context)));
    console.log(`[open-krode] cache warmed: ${rgds.length} RGDs`);
  } catch (e) {
    console.warn("[open-krode] cache warm-up failed:", e);
  }
}

// ─── View request handler (browser-initiated navigation) ─────────────────────

async function handleViewRequest(
  ws: ServerWebSocket<WsData>,
  session: KrodeSession,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const context = session.kubectlContext;
  const cache = session.cache;
  const send = (msg: Record<string, unknown>) => {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  };

  if (action === "open-rgd-graph") {
    const rgdName = payload.rgdName as string;
    if (!rgdName) return;
    try {
      const detail = await cachedGetRGDDetail(cache, rgdName, context);
      const graph = buildRGDGraph(detail);
      const viewId = `view_${Math.random().toString(36).slice(2, 10)}`;
      const view = { id: viewId, mode: "rgd-graph" as const, target: rgdName, kubectlContext: context, data: {} };
      session.views.set(viewId, view);
      send({ type: "view.open", view: { id: viewId, mode: "rgd-graph", target: rgdName, data: {} } });
      const data = {
        rgdName,
        graph,
        rawYaml: detail.rawYaml,
        schema: detail.spec.schema,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        stateNodes: graph.nodes.filter(n => n.isStateNode).map(n => n.label),
        conditionalNodes: graph.nodes.filter(n => n.isConditional).map(n => n.label),
        forEachNodes: graph.nodes.filter(n => n.isForEach).map(n => n.label),
        nodeStates: {},
        reconciling: false,
      };
      view.data = data;
      send({ type: "view.update", viewId, data });
    } catch (e) {
      send({ type: "view.error", viewId: "", error: String(e) });
    }
    return;
  }

  if (action === "list-instances") {
    const rgdName = payload.rgdName as string;
    const viewId = payload.viewId as string;
    if (!rgdName) return;
    try {
      const rgds = await cachedListRGDs(cache, context);
      const rgd = rgds.find(r => r.name === rgdName);
      if (!rgd) { send({ type: "instances.list", viewId, instances: [], rgdName }); return; }
      const instances = await listInstances(rgd, undefined, context);
      console.log(`[open-krode] list-instances ${rgdName}: ${instances.length} found`);
      send({ type: "instances.list", viewId, instances, rgdName });
    } catch (e) {
      console.error(`[open-krode] list-instances error:`, e);
      send({ type: "instances.list", viewId, instances: [], rgdName, error: String(e) });
    }
    return;
  }

  if (action === "open-deep-instance") {
    const rgdName = payload.rgdName as string;
    const namespace = payload.namespace as string;
    const name = payload.name as string;
    if (!rgdName || !namespace || !name) return;

    const viewId = `view_${Math.random().toString(36).slice(2, 10)}`;
    const view = { id: viewId, mode: "deep-instance" as const, target: `${namespace}/${name}`, kubectlContext: context, data: {} as Record<string, unknown> };
    session.views.set(viewId, view);
    const initialData = { loading: true, rgd: { name: rgdName }, namespace, instanceName: name };
    view.data = initialData;
    send({ type: "view.open", view: { id: viewId, mode: "deep-instance", target: `${namespace}/${name}`, data: initialData } });

    // Use cached RGD list so buildDeepInstanceGraph doesn't re-fetch it
    cachedListRGDs(cache, context).then(async rgds => {
      const deepGraph = await buildDeepInstanceGraph(rgds, rgdName, namespace, name, context, {
        getRGDDetail: (n, ctx) => cachedGetRGDDetail(cache, n, ctx),
        getResourceYaml: (ns, kind, n, ctx) => cachedGetResourceYaml(cache, ns, kind, n, ctx),
      });
      const data = { loading: false, deepGraph, rgd: { name: rgdName }, namespace, instanceName: name, lastRefresh: new Date().toISOString() };
      view.data = { ...view.data, ...data };
      send({ type: "view.update", viewId, data: view.data });

      // 5s watcher: re-fetch liveState for each known CR node (cheap — no recursive expansion)
      const watcherId = setInterval(async () => {
        try {
          const updatedNodes = await Promise.all(
            deepGraph.nodes.map(async n => {
              if (!n.crName || !n.namespace || !n.resourceKind) return n;
              try {
                // Bypass cache for watcher — we want fresh data
                const yaml = await getResourceYaml(n.namespace, n.resourceKind, n.crName, context);
                if (!yaml) return { ...n, liveState: "not-found" as const };
                const condMatch = yaml.match(/type:\s*Ready\n\s*status:\s*(True|False)/);
                const reconcilingMatch = yaml.match(/type:\s*Progressing\n\s*status:\s*True/);
                let liveState: import("@/kro/types").LiveState = "ok";
                if (reconcilingMatch) liveState = "reconciling";
                else if (condMatch?.[1] === "True") liveState = "alive";
                else if (condMatch?.[1] === "False") liveState = "error";
                return { ...n, liveState };
              } catch {
                return n;
              }
            })
          );
          const refreshedGraph = { ...deepGraph, nodes: updatedNodes };
          const update = { ...view.data, deepGraph: refreshedGraph, lastRefresh: new Date().toISOString() };
          view.data = update;
          send({ type: "view.update", viewId, data: update });
        } catch { /* ignore */ }
      }, 5000);
      session.watchers.set(viewId, watcherId);
    }).catch(e => {
      const data = { loading: false, error: String(e) };
      view.data = { ...view.data, ...data };
      send({ type: "view.update", viewId, data: view.data });
    });
    return;
  }

  if (action === "open-live-instance") {
    const rgdName = payload.rgdName as string;
    const namespace = payload.namespace as string;
    const name = payload.name as string;
    if (!rgdName || !namespace || !name) return;

    try {
      // Parallel fetch: RGD list + RGD detail (both likely cached)
      const [rgds, detail] = await Promise.all([
        cachedListRGDs(cache, context),
        cachedGetRGDDetail(cache, rgdName, context),
      ]);
      const rgd = rgds.find(r => r.name === rgdName);
      if (!rgd) { send({ type: "view.error", viewId: "", error: `RGD ${rgdName} not found` }); return; }

      const graph = buildRGDGraph(detail);

      let childKinds: string[] = ["configmaps"];
      for (const res of detail.spec.resources ?? []) {
        const tmpl = (res as { template?: Record<string, unknown> }).template;
        if (typeof tmpl?.kind === "string") childKinds.push(tmpl.kind.toLowerCase() + "s");
      }
      childKinds = [...new Set(childKinds)].filter(k => k !== rgd.kind.toLowerCase() + "s");

      // Parallel fetch: instance + events + child resources
      const [instance, events, childResources] = await Promise.all([
        getInstance(rgd.kind, rgd.group, namespace, name, context),
        getInstanceEvents(namespace, name, context),
        getChildResources(namespace, name, childKinds, context),
      ]);

      const reconciling = detectReconciling(instance);
      const nodeStates = buildNodeLiveStates(instance, childResources, graph, reconciling);

      const viewId = `view_${Math.random().toString(36).slice(2, 10)}`;
      const viewData = {
        instance, events, childResources, graph, nodeStates, reconciling,
        rgd: { name: rgdName, kind: rgd.kind, group: rgd.group },
        namespace, instanceName: name, kubectlContext: context,
        lastRefresh: new Date().toISOString(),
      };
      const view = { id: viewId, mode: "instance-graph" as const, target: `${namespace}/${name}`, kubectlContext: context, data: viewData };
      session.views.set(viewId, view);
      send({ type: "view.open", view: { id: viewId, mode: "instance-graph", target: `${namespace}/${name}`, data: viewData } });

      // 5s watcher — parallel refresh
      const watcherId = setInterval(async () => {
        try {
          const [fresh, freshEvents, freshChildren] = await Promise.all([
            getInstance(rgd.kind, rgd.group, namespace, name, context),
            getInstanceEvents(namespace, name, context),
            getChildResources(namespace, name, childKinds, context),
          ]);
          const freshReconciling = detectReconciling(fresh);
          const freshStates = buildNodeLiveStates(fresh, freshChildren, graph, freshReconciling);
          const update = {
            ...view.data,
            instance: fresh, events: freshEvents, childResources: freshChildren,
            nodeStates: freshStates, reconciling: freshReconciling,
            lastRefresh: new Date().toISOString(),
          };
          view.data = update;
          send({ type: "view.update", viewId, data: update });
        } catch { /* ignore watcher errors */ }
      }, 5000);
      session.watchers.set(viewId, watcherId);
    } catch (e) {
      send({ type: "view.error", viewId: "", error: String(e) });
    }
    return;
  }

  if (action === "close-view") {
    const viewId = payload.viewId as string;
    if (!viewId) return;
    session.views.delete(viewId);
    const watcher = session.watchers.get(viewId);
    if (watcher) { clearInterval(watcher); session.watchers.delete(viewId); }
    send({ type: "view.close", viewId });
    return;
  }
}

export async function createSessionServer(
  sessionId: SessionId,
  session: KrodeSession,
  configuredPort?: number,
): Promise<{ server: Server<WsData>; port: number }> {
  const server = Bun.serve<WsData>({
    port: configuredPort ?? 0,

    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { sessionId } });
        if (ok) return undefined;
        return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(serveHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/logo.png") return serveImage(LOGO_PATH, "image/png");
      if (url.pathname === "/favicon.png") return serveImage(FAVICON_PATH, "image/png");

      return new Response("Not Found", { status: HTTP_NOT_FOUND });
    },

    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        session.ws = ws as unknown as WebSocket;
        // Send all open views on connect
        for (const view of session.views.values()) {
          ws.send(
            JSON.stringify({
              type: "view.open",
              view: { id: view.id, mode: view.mode, target: view.target, data: view.data },
            }),
          );
        }
        ws.send(JSON.stringify({ type: "ping" }));

        // Kick off background cache warm-up — don't await, fire and forget
        warmCache(session.cache, session.kubectlContext).catch(() => {});
      },

      close(_ws: ServerWebSocket<WsData>) {
        session.ws = null;
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        try {
          const parsed = JSON.parse(msg.toString()) as { type?: string };
          if (parsed.type === "pong") return;

          if (parsed.type === "view.request") {
            const req = parsed as { type: string; action: string; payload?: Record<string, unknown> };
            handleViewRequest(ws, session, req.action, req.payload ?? {}).catch(() => {});
            return;
          }

          if (parsed.type === "node.inspect") {
            const req = parsed as {
              type: "node.inspect";
              nodeId: string;
              kind: string;
              name: string;
              namespace: string;
              kubectlContext?: string;
            };

            const context = req.kubectlContext ?? session.kubectlContext;
            const kubectlCmd = `kubectl get ${req.kind} ${req.name} -n ${req.namespace} -o yaml${context ? ` --context ${context}` : ""}`;

            // Use cache for node YAML inspect too
            cachedGetResourceYaml(session.cache, req.namespace, req.kind, req.name, context)
              .then((yaml) => {
                ws.send(JSON.stringify({ type: "node.yaml", nodeId: req.nodeId, yaml, kubectlCmd }));
              })
              .catch(() => {
                ws.send(JSON.stringify({ type: "node.yaml", nodeId: req.nodeId, yaml: "", kubectlCmd }));
              });
          }
        } catch {
          // ignore malformed messages
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("Failed to get server port");
  return { server, port };
}

