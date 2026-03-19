// kro data types extracted from kubectl output

export interface RGDSummary {
  name: string;
  group: string;
  kind: string;
  apiVersion: string;
  resourceCount: number;
  age: string;
  // raw conditions from status
  conditions: RGDCondition[];
}

export interface RGDCondition {
  type: string;
  status: string;
  reason: string | undefined;
  message: string | undefined;
}

export interface RGDDetail {
  name: string;
  spec: RGDSpec;
  status: unknown;
  rawYaml: string;
}

export interface RGDSpec {
  schema: {
    apiVersion: string;
    kind: string;
    group: string;
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  };
  resources?: RGDResource[];
}

export interface RGDResource {
  id: string;
  includeWhen?: string[];
  readyWhen?: string[];
  forEach?: unknown;
  // state node (specPatch / stateWrite)
  state?: {
    storeName: string;
    fields: Record<string, string>;
  };
  template?: unknown;
}

export interface RGDGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "root" | "resource" | "state" | "schema-field";
  resourceKind?: string; // K8s kind of the managed resource
  isConditional: boolean;
  isStateNode: boolean;
  isForEach: boolean;
  celExpressions: string[];
  readyWhen: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string | undefined;
  conditional: boolean;
}

export interface InstanceSummary {
  name: string;
  namespace: string;
  rgdName: string;
  kind: string;
  age: string;
  conditions: RGDCondition[];
}

export interface InstanceDetail {
  name: string;
  namespace: string;
  kind: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  conditions: RGDCondition[];
  rawYaml: string;
}

export interface InstanceEvent {
  reason: string;
  message: string;
  type: string; // Normal | Warning
  count: number;
  firstTime: string;
  lastTime: string;
  involvedObjectKind: string;
  involvedObjectName: string;
}

export interface ChildResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  status?: string;
  rawYaml?: string;
}
