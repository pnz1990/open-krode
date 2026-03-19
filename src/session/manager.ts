import { randomUUID } from "node:crypto";
import type { Server } from "bun";
import { openBrowser } from "./browser";
import { createSessionServer } from "./server";
import type { KrodeSession, SessionId, View, ViewId, ViewMode, ViewSnapshot } from "./types";

export class SessionManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessions = new Map<SessionId, { session: KrodeSession; server: Server<any> }>();
  private configuredPort?: number;

  constructor(opts?: { port?: number }) {
    this.configuredPort = opts?.port;
  }

  async startSession(kubectlContext?: string): Promise<{ sessionId: SessionId; url: string }> {
    const sessionId = `krode_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const session: KrodeSession = {
      id: sessionId,
      port: 0,
      kubectlContext,
      views: new Map(),
      ws: null,
      watchers: new Map(),
    };
    const { server, port } = await createSessionServer(sessionId, session, this.configuredPort);
    session.port = port;

    this.sessions.set(sessionId, { session, server });

    const url = `http://localhost:${port}`;
    await openBrowser(url);

    return { sessionId, url };
  }

  async endSession(sessionId: SessionId): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // stop all watchers
    for (const watcher of entry.session.watchers.values()) {
      clearInterval(watcher);
    }

    // close WebSocket
    if (entry.session.ws) {
      try {
        (entry.session.ws as unknown as { close: () => void }).close();
      } catch {
        // ignore
      }
    }

    entry.server.stop(true);
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: SessionId): KrodeSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  openView(
    sessionId: SessionId,
    opts: { mode: ViewMode; target: string; kubectlContext?: string },
  ): ViewId {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const viewId = `view_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const view: View = {
      id: viewId,
      mode: opts.mode,
      target: opts.target,
      kubectlContext: opts.kubectlContext,
      data: {},
    };
    session.views.set(viewId, view);
    this.sendToSession(session, { type: "view.open", view: viewSnap(view) });
    return viewId;
  }

  updateViewData(
    sessionId: SessionId,
    viewId: ViewId,
    data: Record<string, unknown>,
    merge = true,
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const view = session.views.get(viewId);
    if (!view) return;

    view.data = merge ? { ...view.data, ...data } : data;
    this.sendToSession(session, { type: "view.update", viewId, data: view.data });
  }

  closeView(sessionId: SessionId, viewId: ViewId): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const watcher = session.watchers.get(viewId);
    if (watcher) {
      clearInterval(watcher);
      session.watchers.delete(viewId);
    }
    session.views.delete(viewId);
    this.sendToSession(session, { type: "view.close", viewId });
  }

  startWatcher(
    sessionId: SessionId,
    viewId: ViewId,
    intervalMs: number,
    fn: () => Promise<void>,
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    // clear existing watcher for this view
    const existing = session.watchers.get(viewId);
    if (existing) clearInterval(existing);
    const id = setInterval(() => {
      fn().catch((err: unknown) => {
        console.error(`[open-krode] watcher error (view=${viewId}):`, err);
      });
    }, intervalMs);
    session.watchers.set(viewId, id);
  }

  stopWatcher(sessionId: SessionId, viewId: ViewId): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const watcher = session.watchers.get(viewId);
    if (watcher) {
      clearInterval(watcher);
      session.watchers.delete(viewId);
    }
  }

  private sendToSession(session: KrodeSession, msg: Record<string, unknown>): void {
    if (!session.ws) return;
    try {
      (session.ws as unknown as { send: (s: string) => void }).send(JSON.stringify(msg));
    } catch {
      // ignore send errors (ws may have closed)
    }
  }
}

function viewSnap(v: View): ViewSnapshot {
  return { id: v.id, mode: v.mode, target: v.target, data: v.data };
}
