import { tool } from "@opencode-ai/plugin";
import type { SessionManager } from "@/session";
import {
  listRGDs,
  getRGDDetail,
  buildRGDGraph,
  listInstances,
  getInstance,
  getInstanceEvents,
  getChildResources,
  getKubeContexts,
  getCurrentContext,
  detectReconciling,
  buildNodeLiveStates,
  buildDeepInstanceGraph,
} from "@/kro";

const WATCH_INTERVAL_MS = 5000;

// Returns the effective kubectl context: explicit arg > session-stored context
function resolveContext(mgr: SessionManager, sessionId: string, explicitContext?: string): string | undefined {
  if (explicitContext) return explicitContext;
  return mgr.getSession(sessionId)?.kubectlContext;
}

// ─── open_krode_session ───────────────────────────────────────────────────────

export function makeOpenSessionTool(mgr: SessionManager) {
  return tool({
    description:
      "Open the open-krode browser UI. Call this first before using any other open-krode tools. Returns a session_id to pass to subsequent tools.",
    args: {
      kubectl_context: tool.schema.string().optional().describe(
        "kubectl context to use (e.g. arn:aws:eks:... or minikube). Defaults to current context.",
      ),
    },
    async execute(args) {
      const context = args.kubectl_context;
      const currentCtx = context ?? (await getCurrentContext());
      const { sessionId, url } = await mgr.startSession(currentCtx);

      const contexts = await getKubeContexts();

      let rgds: Awaited<ReturnType<typeof listRGDs>> = [];
      try {
        rgds = await listRGDs(context);
      } catch {
        // cluster may not be reachable yet
      }

      mgr.updateViewData(
        sessionId,
        mgr.openView(sessionId, { mode: "rgd-graph", target: "__home__", kubectlContext: context }),
        {
          view: "home",
          currentContext: currentCtx,
          availableContexts: contexts,
          rgds,
        },
      );

      return `session_id: ${sessionId}\nurl: ${url}\nkubectl_context: ${currentCtx}\n\nBrowser opened at ${url}. Use session_id="${sessionId}" in subsequent tools.\nAll tools will automatically use context "${currentCtx}" unless overridden.\n\nFound ${rgds.length} RGD(s): ${rgds.map((r) => r.name).join(", ") || "(none)"}`;
    },
  });
}

// ─── show_rgd_graph ───────────────────────────────────────────────────────────

export function makeShowRgdGraphTool(mgr: SessionManager) {
  return tool({
    description:
      "Show the resource dependency graph (DAG) for a kro ResourceGraphDefinition in the browser UI. The graph shows all managed resources, state nodes, conditional edges (includeWhen), forEach fan-outs, and CEL expressions. Uses CEL reference parsing to build a true multi-depth graph.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("Name of the RGD (e.g. my-app-graph)"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const detail = await getRGDDetail(rgd_name, context);
      const graph = buildRGDGraph(detail);

      // getOrOpenView reuses an existing rgd-graph view for the same target so
      // calling show_rgd_graph multiple times doesn't accumulate stale views.
      const viewId = mgr.getOrOpenView(session_id, {
        mode: "rgd-graph",
        target: rgd_name,
        kubectlContext: context,
      });

      mgr.updateViewData(session_id, viewId, {
        rgdName: rgd_name,
        graph,
        rawYaml: detail.rawYaml,
        schema: detail.spec.schema,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        externalNodes: graph.nodes.filter((n) => n.isExternal || n.isExternalCollection).map((n) => n.label),
        conditionalNodes: graph.nodes.filter((n) => n.isConditional).map((n) => n.label),
        forEachNodes: graph.nodes.filter((n) => n.isForEach).map((n) => n.label),
        // RGD-only graph has no live instance data
        nodeStates: {},
        reconciling: false,
      });

      const externalNodesList = graph.nodes.filter((n) => n.isExternal || n.isExternalCollection).map((n) => n.label);
      const conditionalList = graph.nodes.filter((n) => n.isConditional).map((n) => n.label);

      return [
        `Opened RGD graph for "${rgd_name}" (view: ${viewId})`,
        `  Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`,
        `  Kind: ${detail.spec.schema.kind} (group: ${detail.spec.schema.group})`,
        `  External refs: ${externalNodesList.length > 0 ? externalNodesList.join(", ") : "none"}`,
        `  Conditional (includeWhen): ${conditionalList.length > 0 ? conditionalList.join(", ") : "none"}`,
        `  forEach nodes: ${graph.nodes.filter((n) => n.isForEach).map((n) => n.label).join(", ") || "none"}`,
      ].join("\n");
    },
  });
}

// ─── list_rgd_instances ───────────────────────────────────────────────────────

export function makeListInstancesTool(mgr: SessionManager) {
  return tool({
    description:
      "List all live instances (Custom Resources) of a given kro RGD across the cluster. Shows name, namespace, age, and readiness conditions.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("Name of the RGD whose instances to list"),
      namespace: tool.schema
        .string()
        .optional()
        .describe("Namespace to filter (omit for all namespaces)"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) {
        return `RGD "${rgd_name}" not found. Available: ${rgds.map((r) => r.name).join(", ")}`;
      }

      const instances = await listInstances(rgd, args.namespace, context);

      const homeView = [...(mgr.getSession(session_id)?.views.values() ?? [])].find(
        (v) => v.mode === "rgd-graph" && v.target === "__home__",
      );
      if (homeView) {
        mgr.updateViewData(session_id, homeView.id, { instances, selectedRgd: rgd_name });
      }

      if (instances.length === 0) {
        return `No instances of "${rgd_name}" (kind: ${rgd.kind}) found${args.namespace ? ` in namespace ${args.namespace}` : ""}.`;
      }

      const lines = instances.map(
        (i) =>
          `  ${i.namespace}/${i.name} — age: ${i.age}, ` +
          `conditions: ${i.conditions.map((c) => `${c.type}=${c.status}`).join(", ") || "none"}`,
      );

      return [`${instances.length} instance(s) of "${rgd_name}":`, ...lines].join("\n");
    },
  });
}

// ─── show_instance ────────────────────────────────────────────────────────────

export function makeShowInstanceTool(mgr: SessionManager) {
  return tool({
    description:
      "Open a live observability view for a specific CR instance managed by kro. Shows the live DAG with node states (alive/reconciling/pending/locked), reconcile animation, spec/status diff, events, and child resources. Starts a 5-second polling watcher. Click any node in the browser to inspect its YAML.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("RGD name (e.g. my-app-graph)"),
      namespace: tool.schema.string().describe("Kubernetes namespace of the instance"),
      name: tool.schema.string().describe("Name of the CR instance"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name, namespace, name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) {
        return `RGD "${rgd_name}" not found.`;
      }

      // Fetch RGD detail once — used for graph and child kind derivation
      const detail = await getRGDDetail(rgd_name, context);
      const graph = buildRGDGraph(detail);

      const instance = await getInstance(rgd.kind, rgd.group, namespace, name, context);
      const events = await getInstanceEvents(namespace, name, context);

      // Derive child resource kinds from the RGD's resource templates
      let childKinds: string[] = ["configmaps"];
      for (const res of detail.spec.resources ?? []) {
        const r = res as { template?: unknown };
        const tmpl = r.template as Record<string, unknown> | undefined;
        if (typeof tmpl?.kind === "string") {
          childKinds.push(tmpl.kind.toLowerCase() + "s");
        }
      }
      childKinds = [...new Set(childKinds)].filter(
        (k) => k !== rgd.kind.toLowerCase() + "s",
      );

      const childResources = await getChildResources(namespace, name, childKinds, context);
      const reconciling = detectReconciling(instance);
      const nodeStates = buildNodeLiveStates(instance, childResources, graph, reconciling);

      const viewId = mgr.openView(session_id, {
        mode: "instance-graph",
        target: `${namespace}/${name}`,
        kubectlContext: context,
      });

      mgr.updateViewData(session_id, viewId, {
        instance,
        events,
        childResources,
        graph,
        nodeStates,
        reconciling,
        rgd: { name: rgd_name, kind: rgd.kind, group: rgd.group },
        namespace,
        instanceName: name,
        kubectlContext: context,
        lastRefresh: new Date().toISOString(),
      });

      // Live watcher — refreshes every 5s
      mgr.startWatcher(session_id, viewId, WATCH_INTERVAL_MS, async () => {
        const fresh = await getInstance(rgd.kind, rgd.group, namespace, name, context);
        const freshEvents = await getInstanceEvents(namespace, name, context);
        const freshChildren = await getChildResources(namespace, name, childKinds, context);
        const freshReconciling = detectReconciling(fresh);
        const freshStates = buildNodeLiveStates(fresh, freshChildren, graph, freshReconciling);
        mgr.updateViewData(session_id, viewId, {
          instance: fresh,
          events: freshEvents,
          childResources: freshChildren,
          nodeStates: freshStates,
          reconciling: freshReconciling,
          lastRefresh: new Date().toISOString(),
        });
      });

      const conditionsSummary = instance.conditions
        .map((c) => `${c.type}=${c.status}`)
        .join(", ") || "none";

      return [
        `Opened live instance view for ${namespace}/${name} (view: ${viewId})`,
        `  RGD: ${rgd_name} | Kind: ${rgd.kind}`,
        `  Status: ${reconciling ? "RECONCILING" : "stable"}`,
        `  Conditions: ${conditionsSummary}`,
        `  Events: ${events.length} | Child resources: ${childResources.length}`,
        `  Graph: ${graph.nodes.length} nodes across ${new Set(Object.values(nodeStates)).size} states`,
        `  Auto-refreshing every ${WATCH_INTERVAL_MS / 1000}s — click any node in browser to inspect YAML`,
      ].join("\n");
    },
  });
}

// ─── show_instance_events ─────────────────────────────────────────────────────

export function makeShowEventsTool(mgr: SessionManager) {
  return tool({
    description:
      "Show Kubernetes events for a CR instance. Useful for troubleshooting failed reconciliations.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      namespace: tool.schema.string().describe("Namespace of the instance"),
      name: tool.schema.string().describe("Name of the CR instance"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, namespace, name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const events = await getInstanceEvents(namespace, name, context);

      // Reuse existing view for the same target to prevent unbounded view accumulation
      const viewId = mgr.getOrOpenView(session_id, {
        mode: "instance-events",
        target: `${namespace}/${name}`,
        kubectlContext: context,
      });
      mgr.updateViewData(session_id, viewId, { events, namespace, name });

      if (events.length === 0) {
        return `No Kubernetes events found for ${namespace}/${name}.`;
      }

      const lines = events.slice(0, 20).map(
        (e) =>
          `  [${e.type}] ${e.reason}: ${e.message.slice(0, 100)}${e.message.length > 100 ? "…" : ""} (×${e.count})`,
      );
      return [`${events.length} event(s) for ${namespace}/${name}:`, ...lines].join("\n");
    },
  });
}

// ─── show_instance_yaml ───────────────────────────────────────────────────────

export function makeShowYamlTool(mgr: SessionManager) {
  return tool({
    description:
      "Show the raw YAML of a CR instance in the browser, with syntax highlighting. Good for detailed inspection.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("RGD name"),
      namespace: tool.schema.string().describe("Namespace"),
      name: tool.schema.string().describe("CR instance name"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name, namespace, name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) return `RGD "${rgd_name}" not found.`;

      const instance = await getInstance(rgd.kind, rgd.group, namespace, name, context);

      // Reuse existing view for the same target to prevent unbounded view accumulation
      const viewId = mgr.getOrOpenView(session_id, {
        mode: "instance-yaml",
        target: `${namespace}/${name}`,
        kubectlContext: context,
      });
      mgr.updateViewData(session_id, viewId, {
        rawYaml: instance.rawYaml,
        namespace,
        name,
        kind: rgd.kind,
      });

      return `Opened YAML view for ${namespace}/${name} (view: ${viewId}).\nYAML is ${instance.rawYaml.split("\n").length} lines.`;
    },
  });
}

// ─── show_deep_instance ───────────────────────────────────────────────────────

export function makeShowDeepInstanceTool(mgr: SessionManager) {
  return tool({
    description:
      "Open a deep multi-level instance graph for a CR. Recursively expands forEach instances, sub-RGD CRs, and all child resources up to 4 levels deep. Every node is clickable for YAML inspection. Use this instead of show_instance when you want the full composed resource tree.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("RGD name (e.g. my-app-graph)"),
      namespace: tool.schema.string().describe("Kubernetes namespace of the instance"),
      name: tool.schema.string().describe("Name of the CR instance"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name, namespace, name } = args;
      const context = resolveContext(mgr, session_id, args.kubectl_context);

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) return `RGD "${rgd_name}" not found.`;

      const instance = await getInstance(rgd.kind, rgd.group, namespace, name, context);
      const events = await getInstanceEvents(namespace, name, context);
      const reconciling = detectReconciling(instance);

      const viewId = mgr.openView(session_id, {
        mode: "deep-instance",
        target: `${namespace}/${name}`,
        kubectlContext: context,
      });

      // Start initial render with placeholder
      mgr.updateViewData(session_id, viewId, {
        loading: true,
        instance,
        events,
        reconciling,
        rgd: { name: rgd_name, kind: rgd.kind, group: rgd.group },
        namespace,
        instanceName: name,
        kubectlContext: context,
        lastRefresh: new Date().toISOString(),
      });

      // Build deep graph (async — can take a few seconds)
      buildDeepInstanceGraph(rgds, rgd_name, namespace, name, context).then((deepGraph) => {
        mgr.updateViewData(session_id, viewId, {
          loading: false,
          deepGraph,
          lastRefresh: new Date().toISOString(),
        });
      }).catch((err: unknown) => {
        console.error("[open-krode] deep graph build error:", err);
        mgr.updateViewData(session_id, viewId, { loading: false, error: String(err) });
      });

      // Live watcher refreshes the instance state every 5s
      mgr.startWatcher(session_id, viewId, WATCH_INTERVAL_MS, async () => {
        const fresh = await getInstance(rgd.kind, rgd.group, namespace, name, context);
        const freshEvents = await getInstanceEvents(namespace, name, context);
        const freshReconciling = detectReconciling(fresh);
        mgr.updateViewData(session_id, viewId, {
          instance: fresh,
          events: freshEvents,
          reconciling: freshReconciling,
          lastRefresh: new Date().toISOString(),
        });
      });

      return [
        `Opened deep instance view for ${namespace}/${name} (view: ${viewId})`,
        `  RGD: ${rgd_name} | Kind: ${rgd.kind}`,
        `  Building multi-level graph (may take a moment)…`,
        `  Click any node in the browser to inspect its YAML`,
        `  Auto-refreshing every ${WATCH_INTERVAL_MS / 1000}s`,
      ].join("\n");
    },
  });
}

// ─── close_krode_session ──────────────────────────────────────────────────────

export function makeCloseSessionTool(mgr: SessionManager) {
  return tool({
    description: "Close the open-krode browser session and clean up all watchers.",
    args: {
      session_id: tool.schema.string().describe("session_id to close"),
    },
    async execute(args) {
      await mgr.endSession(args.session_id);
      return `Session ${args.session_id} closed.`;
    },
  });
}

// ─── exports ──────────────────────────────────────────────────────────────────

export function createKrodeTools(mgr: SessionManager) {
  return {
    open_krode_session: makeOpenSessionTool(mgr),
    show_rgd_graph: makeShowRgdGraphTool(mgr),
    list_rgd_instances: makeListInstancesTool(mgr),
    show_instance: makeShowInstanceTool(mgr),
    show_deep_instance: makeShowDeepInstanceTool(mgr),
    show_instance_events: makeShowEventsTool(mgr),
    show_instance_yaml: makeShowYamlTool(mgr),
    close_krode_session: makeCloseSessionTool(mgr),
  };
}
