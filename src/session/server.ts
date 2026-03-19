import type { Server, ServerWebSocket } from "bun";
import { getHtmlBundle } from "@/ui/bundle";
import type { KrodeSession, SessionId } from "./types";

interface WsData {
  sessionId: SessionId;
}

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

export async function createSessionServer(
  sessionId: SessionId,
  session: KrodeSession,
  configuredPort?: number,
): Promise<{ server: Server<WsData>; port: number }> {
  const htmlBundle = getHtmlBundle();

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
        return new Response(htmlBundle, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

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
      },

      close(_ws: ServerWebSocket<WsData>) {
        session.ws = null;
      },

      message(_ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        try {
          const parsed = JSON.parse(msg.toString()) as { type?: string };
          if (parsed.type === "pong") return; // keepalive
          // Future: handle view.request actions
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
