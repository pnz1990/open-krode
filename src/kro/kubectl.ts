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

export function buildRGDGraph(detail: RGDDetail): RGDGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Root node = the CR kind defined by this RGD
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
  });

  for (const res of detail.spec.resources ?? []) {
    const r = res as RGDResource;
    const nodeId = `res:${r.id}`;
    const template = r.template as Record<string, unknown> | undefined;
    const resKind =
      typeof template?.kind === "string" ? template.kind : r.id;

    const isState = !!r.state;
    const isConditional = (r.includeWhen ?? []).length > 0;
    const isForEach = !!r.forEach;

    // collect all CEL expressions embedded in this resource
    const celExprs: string[] = [
      ...(r.includeWhen ?? []),
      ...(r.readyWhen ?? []),
      ...Object.values(r.state?.fields ?? {}),
    ];

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
    });

    edges.push({
      from: rootId,
      to: nodeId,
      conditional: isConditional,
      label: isState ? "specPatch" : isForEach ? "forEach" : undefined,
    });
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
    const cmd = kubectl(
      `get ${kind} -n ${namespace} -o json`,
      context,
    );
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
          status?: Record<string, unknown>;
        }>;
      };

      for (const item of parsed.items) {
        const isOwned = item.metadata.ownerReferences?.some((ref) =>
          ref.name === ownerName
        ) ?? item.metadata.name.startsWith(ownerName);

        if (isOwned) {
          results.push({
            apiVersion: item.apiVersion ?? "v1",
            kind: item.kind ?? kind,
            name: item.metadata.name,
            namespace: item.metadata.namespace ?? namespace,
            status: inferStatus(item.status),
          });
        }
      }
    } catch {
      // kind may not exist in this cluster
    }
  }

  return results;
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
