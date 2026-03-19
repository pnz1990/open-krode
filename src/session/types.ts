// Session types for open-krode
// A session hosts a single browser window with the kro explorer UI

export type SessionId = string;
export type ViewId = string;

export type ViewMode = "rgd-graph" | "instance-graph" | "deep-instance" | "instance-events" | "instance-yaml";

export interface View {
  id: ViewId;
  mode: ViewMode;
  // For rgd-graph: the RGD name
  // For instance-*: namespace/name of the CR instance
  target: string;
  // Optional: which context/cluster to use
  kubectlContext?: string;
  // Payload sent down to UI (updated by tools)
  data: Record<string, unknown>;
}

// ─── Simple TTL cache ──────────────────────────────────────────────────────────
interface CacheEntry<T> { value: T; expiresAt: number }

export class KrodeCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return undefined; }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

export interface KrodeSession {
  id: SessionId;
  port: number;
  // kubectl context detected (or supplied) when session was opened
  kubectlContext?: string;
  views: Map<ViewId, View>;
  ws: WebSocket | null;
  // watch interval ids
  watchers: Map<ViewId, ReturnType<typeof setInterval>>;
  // in-process cache to avoid redundant kubectl calls
  cache: KrodeCache;
}

// WebSocket messages: server → browser
export type ServerMessage =
  | { type: "view.open"; view: ViewSnapshot }
  | { type: "view.update"; viewId: ViewId; data: Record<string, unknown> }
  | { type: "view.close"; viewId: ViewId }
  | { type: "node.yaml"; nodeId: string; yaml: string; kubectlCmd: string }
  | { type: "ping" };

// WebSocket messages: browser → server
export type ClientMessage =
  | { type: "connected" }
  | { type: "pong" }
  | { type: "view.request"; viewId: ViewId; action: string; payload?: Record<string, unknown> }
  | { type: "node.inspect"; viewId: ViewId; nodeId: string; kind: string; name: string; namespace: string; kubectlContext?: string };

export interface ViewSnapshot {
  id: ViewId;
  mode: ViewMode;
  target: string;
  data: Record<string, unknown>;
}
