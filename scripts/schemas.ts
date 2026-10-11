import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  args,
  results,
  capabilities,
  envelope,
  reconciliation,
  operations,
  id,
  VERSION,
} from "../src/protocol.js";
await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries({
  capabilities,
  envelope,
  reconciliation,
  ...Object.fromEntries(
    operations.flatMap((op) => [
      [op + ".arguments", args[op]],
      [
        op + ".request",
        args[op].extend({
          protocol_version: z.literal(VERSION),
          request_id: id,
          project_id: id,
          session_id: id,
        }),
      ],
      [op + ".response", results[op]],
    ]),
  ),
})) {
  await writeFile(
    `schemas/${name}.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
}
const { assigned, cap, state, inputs } = await import("../test/fixtures.js");
await mkdir("examples/fixtures", { recursive: true });
for (const [name, value] of Object.entries({
  capabilities: cap,
  assignment: assigned("/worktrees/approved-task"),
  status: state("/worktrees/approved-task"),
  ...Object.fromEntries(
    operations.map((op) => [op + ".arguments", inputs[op]]),
  ),
  error: {
    protocol_version: "0.1",
    request_id: "example-request",
    project_id: "project-1",
    session_id: "session-1",
    error: { code: "stale_lease" },
  },
  no_task: { kind: "no_task" },
  verification: { verification_id: "verification-1", status: "queued" },
  candidate: {
    status: "accepted_for_integration",
    reasons: [],
    state_revision: 2,
  },
})) {
  await writeFile(
    `examples/fixtures/${name}.json`,
    JSON.stringify(value, null, 2) + "\n",
  );
}
