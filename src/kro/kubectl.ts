import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type {
  RGDSummary,
  RGDDetail,
  RGDGraph,
  GraphNode,
  GraphEdge,
  InstanceSummary,
  InstanceDetail,
  InstanceEvent,
  ChildResource,
  RGDCondition,
  RGDResource,
  LiveState,
} from "./types";

const exec = promisify(execCb);

const KRO_GROUP = "kro.run";
const RGD_RESOURCE = "resourcegraphdefinitions";

// ─── kubectl helpers ──────────────────────────────────────────────────────────

function kubectl(args: string, context?: string): string {
  const ctxFlag = context ? `--context ${context} ` : "";
  return `kubectl ${ctxFlag}${args}`;
}

async function run(cmd: string): Promise<string> {
  const { stdout } = await exec(cmd, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

// ─── RGD operations ───────────────────────────────────────────────────────────

export async function listRGDs(context?: string): Promise<RGDSummary[]> {
  const cmd = kubectl(`get ${RGD_RESOURCE} -o json`, context);
  const raw = await run(cmd);
  const parsed = JSON.parse(raw) as {
    items: Array<{
      metadata: { name: string; creationTimestamp: string };
      spec: {
        schema?: {
          apiVersion?: string;
          kind?: string;
          group?: string;
        };
        resources?: unknown[];
      };
      status?: {
        conditions?: Array<{
          type: string;
          status: string;
          reason?: string;
          message?: string;
        }>;
      };
    }>;
  };

  return parsed.items.map((item) => ({
    name: item.metadata.name,
    group: item.spec.schema?.group ?? KRO_GROUP,
    kind: item.spec.schema?.kind ?? item.metadata.name,
    apiVersion: item.spec.schema?.apiVersion ?? "v1alpha1",
    resourceCount: item.spec.resources?.length ?? 0,
    age: relativeAge(item.metadata.creationTimestamp),
    conditions: (item.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
  }));
}

export async function getRGDDetail(name: string, context?: string): Promise<RGDDetail> {
  const cmd = kubectl(`get ${RGD_RESOURCE} ${name} -o json`, context);
  const raw = await run(cmd);
  const obj = JSON.parse(raw) as {
    spec: RGDDetail["spec"];
    status: unknown;
  };

  const yamlCmd = kubectl(`get ${RGD_RESOURCE} ${name} -o yaml`, context);
  const rawYaml = await run(yamlCmd);

  return {
    name,
    spec: obj.spec,
    status: obj.status,
    rawYaml,
  };
}

// ─── CEL dependency parsing ───────────────────────────────────────────────────
//
// kro resource templates reference other resources via CEL expressions like:
//   kr.resources.<id>.<field>
//   ${schema.resources.<id>.spec.*}
//   ${kr.resources.<id>.status.*}
//
// We scan the serialised template JSON for these patterns to extract real
// resource-to-resource dependencies and build a multi-depth DAG instead of
// a flat star topology.

function extractResourceRefs(templateJson: string, knownIds: Set<string>): string[] {
  const refs = new Set<string>();
  // Match kr.resources.<id> and schema.resources.<id> patterns
  const patterns = [
    /kr\.resources\.(\w+)/g,
    /schema\.resources\.(\w+)/g,
    /\$\{[^}]*resources\.(\w+)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(templateJson)) !== null) {
      const id = m[1];
      if (id && knownIds.has(id)) refs.add(id);
    }
  }
  return [...refs];
}

export function buildRGDGraph(detail: RGDDetail): RGDGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const rootId = `rgd:${detail.name}`;
  nodes.push({
    id: rootId,
    label: detail.spec.schema.kind,
    kind: "root",
    resourceKind: detail.spec.schema.kind,
    isConditional: false,
    isStateNode: false,
    isForEach: false,
    celExpressions: [],
    readyWhen: [],
    exists: true,
    detail: `${detail.spec.schema.group} / ${detail.spec.schema.kind}`,
    liveState: "alive",
  });

  const resources = (detail.spec.resources ?? []) as RGDResource[];
  const knownIds = new Set(resources.map((r) => r.id));

  // First pass: create all nodes
  for (const r of resources) {
    const nodeId = `res:${r.id}`;
    const template = r.template as Record<string, unknown> | undefined;
    const resKind =
      typeof template?.kind === "string" ? template.kind : r.id;

    const isState = !!r.state;
    const isConditional = (r.includeWhen ?? []).length > 0;
    const isForEach = !!r.forEach;

    const celExprs: string[] = [
      ...(r.includeWhen ?? []),
      ...(r.readyWhen ?? []),
      ...Object.values(r.state?.fields ?? {}),
    ];

    // Build a detail hint from CEL metadata
    const parts: string[] = [];
    if (isConditional) parts.push(`includeWhen: ${(r.includeWhen ?? []).join("; ").slice(0, 60)}`);
    if (r.readyWhen?.length) parts.push(`readyWhen: ${r.readyWhen[0]!.slice(0, 60)}`);
    if (isForEach) parts.push("forEach fan-out");
    if (isState) parts.push(`specPatch → ${r.state?.storeName ?? "?"}`);

    nodes.push({
      id: nodeId,
      label: r.id,
      kind: isState ? "state" : "resource",
      resourceKind: resKind,
      isConditional,
      isStateNode: isState,
      isForEach,
      celExpressions: celExprs,
      readyWhen: r.readyWhen ?? [],
      exists: true,
      detail: parts.join(" · ") || resKind,
      liveState: "unknown",
    });
  }

  // Second pass: build edges using CEL dependency extraction
  // If resource B's template references kr.resources.A, then A → B.
  // Resources with no inter-resource refs fall back to root → resource.
  for (const r of resources) {
    const nodeId = `res:${r.id}`;
    const isConditional = (r.includeWhen ?? []).length > 0;

    // Scan template + CEL expressions for references to sibling resources
    const templateJson = JSON.stringify(r.template ?? {});
    const celJson = JSON.stringify([
      ...(r.includeWhen ?? []),
      ...(r.readyWhen ?? []),
      ...Object.values(r.state?.fields ?? {}),
    ]);
    const allJson = templateJson + celJson;

    const refs = extractResourceRefs(allJson, knownIds).filter((id) => id !== r.id);

    if (refs.length > 0) {
      // Add edges from each referenced resource → this resource
      for (const refId of refs) {
        edges.push({
          from: `res:${refId}`,
          to: nodeId,
          conditional: isConditional,
          dashed: isConditional,
          label: isConditional ? "includeWhen" : undefined,
        });
      }
    } else {
      // No inter-resource refs → depends directly on root
      edges.push({
        from: rootId,
        to: nodeId,
        conditional: isConditional,
        dashed: isConditional,
        label: r.state ? "specPatch" : r.forEach ? "forEach" : isConditional ? "includeWhen" : undefined,
      });
    }
  }

  return { nodes, edges };
}

// ─── Instance operations ──────────────────────────────────────────────────────

export async function listInstances(
  rgdSummary: RGDSummary,
  namespace?: string,
  context?: string,
): Promise<InstanceSummary[]> {
  const nsFlag = namespace ? `-n ${namespace}` : "-A";
  const resource = `${rgdSummary.kind.toLowerCase()}.${rgdSummary.group}`;
  const cmd = kubectl(`get ${resource} ${nsFlag} -o json`, context);

  let raw: string;
  try {
    raw = await run(cmd);
  } catch {
    return [];
  }

  const parsed = JSON.parse(raw) as {
    items: Array<{
      metadata: { name: string; namespace?: string; creationTimestamp: string };
      status?: {
        conditions?: Array<{
          type: string;
          status: string;
          reason?: string;
          message?: string;
        }>;
      };
    }>;
  };

  return parsed.items.map((item) => ({
    name: item.metadata.name,
    namespace: item.metadata.namespace ?? "default",
    rgdName: rgdSummary.name,
    kind: rgdSummary.kind,
    age: relativeAge(item.metadata.creationTimestamp),
    conditions: (item.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
  }));
}

export async function getInstance(
  kind: string,
  group: string,
  namespace: string,
  name: string,
  context?: string,
): Promise<InstanceDetail> {
  const resource = `${kind.toLowerCase()}.${group}`;
  const cmd = kubectl(`get ${resource} ${name} -n ${namespace} -o json`, context);
  const raw = await run(cmd);
  const obj = JSON.parse(raw) as {
    spec?: Record<string, unknown>;
    status?: Record<string, unknown> & {
      conditions?: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
      }>;
    };
  };

  const yamlCmd = kubectl(`get ${resource} ${name} -n ${namespace} -o yaml`, context);
  const rawYaml = await run(yamlCmd);

  return {
    name,
    namespace,
    kind,
    spec: obj.spec ?? {},
    status: obj.status ?? {},
    conditions: (obj.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
    rawYaml,
  };
}

export async function getInstanceEvents(
  namespace: string,
  name: string,
  context?: string,
): Promise<InstanceEvent[]> {
  const cmd = kubectl(
    `get events -n ${namespace} --field-selector involvedObject.name=${name} -o json`,
    context,
  );
  let raw: string;
  try {
    raw = await run(cmd);
  } catch {
    return [];
  }

  const parsed = JSON.parse(raw) as {
    items: Array<{
      reason: string;
      message: string;
      type: string;
      count?: number;
      firstTimestamp?: string;
      lastTimestamp?: string;
      involvedObject: { kind: string; name: string };
    }>;
  };

  return parsed.items.map((e) => ({
    reason: e.reason,
    message: e.message,
    type: e.type,
    count: e.count ?? 1,
    firstTime: e.firstTimestamp ?? "",
    lastTime: e.lastTimestamp ?? "",
    involvedObjectKind: e.involvedObject.kind,
    involvedObjectName: e.involvedObject.name,
  }));
}

export async function getChildResources(
  namespace: string,
  ownerName: string,
  kinds: string[],
  context?: string,
): Promise<ChildResource[]> {
  const results: ChildResource[] = [];

  for (const kind of kinds) {
    const cmd = kubectl(`get ${kind} -n ${namespace} -o json`, context);
    try {
      const raw = await run(cmd);
      const parsed = JSON.parse(raw) as {
        items: Array<{
          apiVersion?: string;
          kind?: string;
          metadata: {
            name: string;
            namespace?: string;
            ownerReferences?: Array<{ name: string }>;
          };
          status?: Record<string, unknown> & {
            conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          };
        }>;
      };

      for (const item of parsed.items) {
        const isOwned =
          item.metadata.ownerReferences?.some((ref) => ref.name === ownerName) ??
          item.metadata.name.startsWith(ownerName);

        if (isOwned) {
          results.push({
            apiVersion: item.apiVersion ?? "v1",
            kind: item.kind ?? kind,
            name: item.metadata.name,
            namespace: item.metadata.namespace ?? namespace,
            status: inferStatus(item.status),
            conditions: (item.status?.conditions ?? []).map((c) => ({
              type: c.type,
              status: c.status,
              reason: c.reason,
              message: c.message,
            })),
          });
        }
      }
    } catch {
      // kind may not exist in this cluster
    }
  }

  return results;
}

// ─── Resource YAML fetcher (for click-to-yaml in browser) ────────────────────

export async function getResourceYaml(
  namespace: string,
  kind: string,
  name: string,
  context?: string,
): Promise<string> {
  const cmd = kubectl(`get ${kind} ${name} -n ${namespace} -o yaml`, context);
  try {
    return await run(cmd);
  } catch {
    return "";
  }
}

// ─── Live state helpers ───────────────────────────────────────────────────────

export function detectReconciling(instance: InstanceDetail): boolean {
  // Progressing=True means kro is actively reconciling
  const progressing = instance.conditions.find((c) => c.type === "Progressing");
  if (progressing?.status === "True") return true;
  // Ready=False also indicates an in-progress or failed reconcile
  const ready = instance.conditions.find((c) => c.type === "Ready");
  if (ready?.status === "False") return true;
  return false;
}

export function buildNodeLiveStates(
  instance: InstanceDetail,
  childResources: ChildResource[],
  graph: RGDGraph,
  reconciling: boolean,
): Record<string, LiveState> {
  const states: Record<string, LiveState> = {};

  for (const node of graph.nodes) {
    if (node.kind === "root") {
      states[node.id] = reconciling ? "reconciling" : "alive";
      continue;
    }

    if (node.isStateNode) {
      // specPatch state nodes: reconciling when the instance is reconciling
      states[node.id] = reconciling ? "reconciling" : "ok";
      continue;
    }

    // Try to match this graph node to a child resource by K8s kind
    const nodeKind = (node.resourceKind ?? node.label).toLowerCase();
    const match = childResources.find(
      (cr) => cr.kind.toLowerCase() === nodeKind || cr.kind.toLowerCase() === nodeKind + "s",
    );

    if (match) {
      if (reconciling) {
        states[node.id] = "reconciling";
      } else {
        const s = match.status ?? "unknown";
        if (s === "ready" || s === "alive") states[node.id] = "alive";
        else if (s === "dead") states[node.id] = "error";
        else if (s === "not-ready") states[node.id] = "pending";
        else states[node.id] = "ok";
      }
    } else if (node.isConditional) {
      // Conditional resource that doesn't exist = includeWhen is false
      states[node.id] = "not-found";
    } else {
      states[node.id] = "unknown";
    }
  }

  return states;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function relativeAge(timestamp: string): string {
  if (!timestamp) return "unknown";
  const ms = Date.now() - new Date(timestamp).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function inferStatus(status: Record<string, unknown> | undefined): string {
  if (!status) return "unknown";
  // kro pattern: ConfigMaps have entityState field set via specPatch
  if (typeof status["entityState"] === "string") return status["entityState"] as string;
  // generic ready condition
  const conditions = status["conditions"] as Array<{ type: string; status: string }> | undefined;
  if (conditions) {
    const ready = conditions.find((c) => c.type === "Ready");
    if (ready) return ready.status === "True" ? "ready" : "not-ready";
  }
  return "unknown";
}

export async function getKubeContexts(): Promise<string[]> {
  try {
    const raw = await run("kubectl config get-contexts -o name");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function getCurrentContext(): Promise<string> {
  try {
    return await run("kubectl config current-context");
  } catch {
    return "";
  }
}
