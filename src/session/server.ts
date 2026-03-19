import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { getHtmlBundle } from "@/ui/bundle";
import { getResourceYaml } from "@/kro";
import type { KrodeSession, SessionId } from "./types";

interface WsData {
  sessionId: SessionId;
}

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

// Resolve the path to dist/ui.html relative to this file's location.
// import.meta.dir is Bun-specific; fall back to import.meta.url for Node.js compatibility.
const _metaDir: string =
  (import.meta as { dir?: string }).dir ??
  (() => {
    const { fileURLToPath } = require("node:url") as { fileURLToPath: (u: string) => string };
    return join(fileURLToPath(import.meta.url), "..");
  })();
const UI_HTML_PATH = join(_metaDir, "ui.html");

function serveHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf-8");
  } catch {
    // Fallback: generate in-process (happens when ui.html hasn't been written yet)
    return getHtmlBundle();
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
        // Read from disk on every request — allows UI updates without restarting OpenCode
        return new Response(serveHtml(), {
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

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        try {
          const parsed = JSON.parse(msg.toString()) as { type?: string };
          if (parsed.type === "pong") return;

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

            getResourceYaml(req.namespace, req.kind, req.name, context)
              .then((yaml) => {
                ws.send(
                  JSON.stringify({
                    type: "node.yaml",
                    nodeId: req.nodeId,
                    yaml,
                    kubectlCmd,
                  }),
                );
              })
              .catch(() => {
                ws.send(
                  JSON.stringify({
                    type: "node.yaml",
                    nodeId: req.nodeId,
                    yaml: "",
                    kubectlCmd,
                  }),
                );
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
