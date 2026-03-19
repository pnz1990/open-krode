import type { Plugin } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import { SessionManager } from "@/session";
import { createKrodeTools } from "@/tools";
import { KRODE_AGENT_PROMPT } from "@/agent/prompt";

const KrodePlugin: Plugin = async () => {
  const mgr = new SessionManager();

  // Track which krode sessions belong to which opencode sessions
  const tracked = new Map<string, Set<string>>();

  const tools = createKrodeTools(mgr);

  // Wrap open_krode_session to track the session ownership
  const originalExecute = tools.open_krode_session.execute;
  const wrapped = async (
    args: Parameters<typeof originalExecute>[0],
    ctx: Parameters<typeof originalExecute>[1],
  ) => {
    const result = await originalExecute(args, ctx);
    const match = result.match(/session_id: (krode_\w+)/);
    if (match && ctx.sessionID) {
      if (!tracked.has(ctx.sessionID)) tracked.set(ctx.sessionID, new Set());
      tracked.get(ctx.sessionID)?.add(match[1] as string);
    }
    return result;
  };
  tools.open_krode_session = { ...tools.open_krode_session, execute: wrapped };

  return {
    tool: tools,

    config: async (config: Config) => {
      if (!config.agent) config.agent = {};
      config.agent["krode"] = {
        model: "anthropic/claude-sonnet-4-5",
        prompt: KRODE_AGENT_PROMPT,
        description:
          "kro RGD visualization and live instance observability. Explores ResourceGraphDefinitions (DAG), explains CEL expressions and specPatch nodes, and watches live kro instances.",
        tools: {
          open_krode_session: true,
          show_rgd_graph: true,
          list_rgd_instances: true,
          show_instance: true,
          show_instance_events: true,
          show_instance_yaml: true,
          close_krode_session: true,
          bash: true,
          read: true,
          glob: true,
          grep: true,
        },
      };
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;
      const props = event.properties as Record<string, unknown>;
      const info = props["info"] as Record<string, unknown> | undefined;
      const id = info?.["id"] as string | undefined;
      if (!id) return;
      const krodeSessions = tracked.get(id);
      if (krodeSessions) {
        for (const sessionId of krodeSessions) {
          await mgr.endSession(sessionId);
        }
        tracked.delete(id);
      }
    },
  };
};

export default KrodePlugin;
