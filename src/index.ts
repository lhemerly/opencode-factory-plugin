import { tool, type Plugin, type ToolDefinition } from "@opencode-ai/plugin";
import { FactoryClient } from "./client.js";
import { args, operations, BridgeError } from "./protocol.js";
// Single export prevents OpenCode from instantiating the same plugin twice.
export const FactoryPlugin: Plugin = async ({ worktree }) => {
  if (process.env.FACTORY_ENABLED !== "1") return {};
  const project_id = process.env.FACTORY_PROJECT_ID;
  const endpoint = process.env.FACTORY_CONTROLLER_URL;
  if (!project_id || !endpoint) throw new BridgeError("validation_failed");
  const client = new FactoryClient({
    endpoint,
    project_id,
    worktree,
    token: process.env.FACTORY_TOKEN,
    timeout_ms: Number(process.env.FACTORY_TIMEOUT_MS ?? 10000),
  });
  const tools: Record<string, ToolDefinition> = {};
  const descriptions = {
    factory_status:
      "Read authoritative code factory state, blockers and exact verification evidence.",
    factory_next_task:
      "Claim already-approved factory work bound to this session and worktree. Reuse the idempotency key when reconciling a timeout.",
    factory_request_verification:
      "Request independent verification of an exact commit using a registered profile. No arbitrary commands. Reuse the same idempotency key on retry.",
    factory_submit_candidate:
      "Submit a verified candidate for controller integration. This cannot mark a job done. Reuse the same idempotency key on retry.",
  };
  for (const op of operations) {
    tools[op] = tool({
      description: descriptions[op],
      args: args[op].shape,
      async execute(input, context) {
        try {
          return JSON.stringify(await client.call(op, input, context));
        } catch (e) {
          return JSON.stringify(
            e instanceof BridgeError
              ? e.toJSON()
              : new BridgeError("validation_failed").toJSON(),
          );
        }
      },
    });
  }
  return {
    tool: tools,
    dispose: async () => client.dispose(),
    event: async ({ event }) => {
      // Idle and model messages are observations; neither authorizes a transition.
      if (event.type === "session.deleted") {
        client.cancelSession(event.properties.info.id);
      }
      if (event.type === "session.idle") {
        try {
          await client.call(
            "factory_status",
            { project_id },
            {
              sessionID: event.properties.sessionID,
              worktree,
              abort: new AbortController().signal,
            },
          );
        } catch {
          /* Outages are reported by tools; observations never change job state. */
        }
      }
    },
  };
};
