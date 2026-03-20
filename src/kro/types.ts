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
  // externalRef: references an existing resource (single or by selector)
  externalRef?: {
    apiVersion: string;
    kind: string;
    metadata: { name?: string; namespace?: string; selector?: unknown };
  };
  template?: unknown;
}

export interface RGDGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type LiveState =
  | "alive"
  | "reconciling"
  | "pending"
  | "not-found"
  | "error"
  | "unknown"
  | "ok"
  | "meta";

export interface GraphNode {
  id: string;
  label: string;
  // Upstream kro node types (pkg/graph/node.go NodeType constants)
  kind: "root" | "resource" | "collection" | "external" | "externalCollection";
  resourceKind?: string;
  isConditional: boolean;   // has includeWhen set (modifier, not a separate type)
  isForEach: boolean;       // NodeTypeCollection
  isExternal: boolean;      // NodeTypeExternal or NodeTypeExternalCollection
  isExternalCollection: boolean; // NodeTypeExternalCollection (selector-based)
  celExpressions: string[];
  readyWhen: string[];
  includeWhen?: string[];
  forEachExpr?: string;     // forEach dimension CEL expression
  templateSnippet?: string; // first ~400 chars of template YAML
  // Live instance overlay
  exists?: boolean;
  detail?: string;
  liveState?: LiveState;
  liveConditions?: RGDCondition[];
  // For deep instance graph nodes
  namespace?: string;
  crName?: string;
  rgdName?: string;
  isForEachInstance?: boolean;
  depth?: number;
  parentId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string | undefined;
  conditional: boolean;
  dashed?: boolean;       // true = conditional / includeWhen edge
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
  conditions?: RGDCondition[];
}

// Deep instance graph — fully resolved multi-level graph for a live CR
export interface DeepInstanceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // map of nodeId -> raw YAML (pre-fetched for clickable nodes)
  yamlCache: Record<string, string>;
}
