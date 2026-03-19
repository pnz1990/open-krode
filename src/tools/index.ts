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
} from "@/kro";

const WATCH_INTERVAL_MS = 5000;

// ─── open_krode_session ───────────────────────────────────────────────────────
// Opens the browser window for the current kro exploration session.

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
      const { sessionId, url } = await mgr.startSession();

      // Detect current context for the session metadata
      const currentCtx = context ?? (await getCurrentContext());
      const contexts = await getKubeContexts();

      // Pre-load RGD list into the session
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

      return `session_id: ${sessionId}\nurl: ${url}\n\nBrowser opened at ${url}. Use session_id="${sessionId}" in subsequent tools.\n\nFound ${rgds.length} RGD(s): ${rgds.map((r) => r.name).join(", ") || "(none)"}`;
    },
  });
}

// ─── show_rgd_graph ───────────────────────────────────────────────────────────

export function makeShowRgdGraphTool(mgr: SessionManager) {
  return tool({
    description:
      "Show the resource dependency graph (DAG) for a kro ResourceGraphDefinition in the browser UI. The graph shows all managed resources, state nodes, conditional edges (includeWhen), forEach fan-outs, and CEL expressions.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("Name of the RGD (e.g. dungeon-graph)"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name } = args;
      const context = args.kubectl_context;

      const detail = await getRGDDetail(rgd_name, context);
      const graph = buildRGDGraph(detail);

      const viewId = mgr.openView(session_id, {
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
        stateNodes: graph.nodes.filter((n) => n.isStateNode).map((n) => n.label),
        conditionalNodes: graph.nodes.filter((n) => n.isConditional).map((n) => n.label),
        forEachNodes: graph.nodes.filter((n) => n.isForEach).map((n) => n.label),
      });

      const stateNodesList = graph.nodes.filter((n) => n.isStateNode).map((n) => n.label);
      const conditionalList = graph.nodes.filter((n) => n.isConditional).map((n) => n.label);

      return [
        `Opened RGD graph for "${rgd_name}" (view: ${viewId})`,
        `  Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`,
        `  Kind: ${detail.spec.schema.kind} (group: ${detail.spec.schema.group})`,
        `  State nodes (specPatch): ${stateNodesList.length > 0 ? stateNodesList.join(", ") : "none"}`,
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
      const context = args.kubectl_context;

      // Need the RGD summary to know the group/kind
      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) {
        return `RGD "${rgd_name}" not found. Available: ${rgds.map((r) => r.name).join(", ")}`;
      }

      const instances = await listInstances(rgd, args.namespace, context);

      // Update the home view with instance list
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
      "Open a live observability view for a specific CR instance managed by kro. Shows the instance spec/status, live reconcile state, and starts a 5-second polling watcher that auto-refreshes the browser UI.",
    args: {
      session_id: tool.schema.string().describe("session_id returned by open_krode_session"),
      rgd_name: tool.schema.string().describe("RGD name (e.g. dungeon-graph)"),
      namespace: tool.schema.string().describe("Kubernetes namespace of the instance"),
      name: tool.schema.string().describe("Name of the CR instance"),
      kubectl_context: tool.schema.string().optional().describe("kubectl context override"),
    },
    async execute(args) {
      const { session_id, rgd_name, namespace, name } = args;
      const context = args.kubectl_context;

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) {
        return `RGD "${rgd_name}" not found.`;
      }

      const instance = await getInstance(rgd.kind, rgd.group, namespace, name, context);
      const events = await getInstanceEvents(namespace, name, context);

      const viewId = mgr.openView(session_id, {
        mode: "instance-graph",
        target: `${namespace}/${name}`,
        kubectlContext: context,
      });

      mgr.updateViewData(session_id, viewId, {
        instance,
        events,
        rgd: { name: rgd_name, kind: rgd.kind, group: rgd.group },
        lastRefresh: new Date().toISOString(),
      });

      // Start live watcher
      mgr.startWatcher(session_id, viewId, WATCH_INTERVAL_MS, async () => {
        const fresh = await getInstance(rgd.kind, rgd.group, namespace, name, context);
        const freshEvents = await getInstanceEvents(namespace, name, context);
        mgr.updateViewData(session_id, viewId, {
          instance: fresh,
          events: freshEvents,
          lastRefresh: new Date().toISOString(),
        });
      });

      const conditionsSummary = instance.conditions
        ? (instance.conditions as Array<{ type: string; status: string }>)
            .map((c) => `${c.type}=${c.status}`)
            .join(", ")
        : "none";

      return [
        `Opened live instance view for ${namespace}/${name} (view: ${viewId})`,
        `  RGD: ${rgd_name} | Kind: ${rgd.kind}`,
        `  Status conditions: ${conditionsSummary}`,
        `  Recent events: ${events.length}`,
        `  Auto-refreshing every ${WATCH_INTERVAL_MS / 1000}s`,
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
      const context = args.kubectl_context;

      const events = await getInstanceEvents(namespace, name, context);

      const viewId = mgr.openView(session_id, {
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
      const context = args.kubectl_context;

      const rgds = await listRGDs(context);
      const rgd = rgds.find((r) => r.name === rgd_name);
      if (!rgd) return `RGD "${rgd_name}" not found.`;

      const instance = await getInstance(rgd.kind, rgd.group, namespace, name, context);

      const viewId = mgr.openView(session_id, {
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
    show_instance_events: makeShowEventsTool(mgr),
    show_instance_yaml: makeShowYamlTool(mgr),
    close_krode_session: makeCloseSessionTool(mgr),
  };
}
