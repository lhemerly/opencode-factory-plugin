import { z } from "zod";
export const VERSION = "0.1" as const;
export const id = z.string().min(1).max(200);
export const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const timestamp = z.iso.datetime();
export const operations = [
  "factory_status",
  "factory_next_task",
  "factory_request_verification",
  "factory_submit_candidate",
] as const;
export const operation = z.enum(operations);
export const artifact = z.object({
  reference: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const receipt = z
  .object({
    verification_id: id,
    candidate_commit: commit,
    verification_profile_id: id,
    profile_version: id,
    environment_id: id,
    outcome: z.enum(["passed", "failed"]),
    commands: z
      .array(
        z.object({
          command: z.string().max(1000),
          exit_status: z.number().int(),
        }),
      )
      .min(1)
      .max(100),
    artifacts: z.array(artifact).max(100),
  })
  .refine(
    (value) =>
      value.outcome !== "passed" ||
      value.commands.every((command) => command.exit_status === 0),
    { message: "Passed receipts require every command to exit successfully" },
  );
export const assignment = z.object({
  job_id: id,
  attempt_id: id,
  lease_id: id,
  session_id: id,
  lease_expires_at: timestamp,
  repository_id: id,
  approved_base_commit: commit,
  worktree_binding: z.string().min(1),
  task_brief: z.string().max(8000),
  acceptance_criteria: z.array(z.string().max(1000)).max(50),
  protected_paths: z.array(z.string().max(500)).max(100),
  allowed_verification_profiles: z.array(id).max(100),
  limits: z.object({
    max_attempts: z.number().int().positive(),
    timeout_seconds: z.number().int().positive(),
  }),
  policy_version: id,
});
export const capabilities = z.object({
  protocol_min: z.literal(VERSION),
  protocol_max: z.literal(VERSION),
  operations: z.array(operation),
  worker_adapters: z.array(id),
  verification_profiles: z.array(id),
});
export const status = z
  .object({
    state: z.enum([
      "queued",
      "running",
      "verifying",
      "blocked",
      "retry_wait",
      "paused",
      "done",
    ]),
    state_revision: z.number().int().nonnegative(),
    current_attempt: assignment.nullable(),
    permitted_next_actions: z.array(operation),
    blockers: z.array(z.string().max(1000)).max(50),
    active_verification_receipt: receipt.nullable(),
    delivery_reference: z.string().max(2048).nullable(),
    freshness_timestamp: timestamp,
    next_retry_at: timestamp.nullable(),
    outcome: z.string().max(500).nullable(),
  })
  .superRefine((v, c) => {
    if (
      v.state === "done" &&
      (!v.delivery_reference ||
        v.active_verification_receipt?.outcome !== "passed")
    )
      c.addIssue({
        code: "custom",
        message: "Completion requires delivery and passed evidence",
      });
  });
export const args = {
  factory_status: z.object({ project_id: id, job_id: id.optional() }).strict(),
  factory_next_task: z
    .object({
      project_id: id,
      session_id: id,
      adapter_capabilities: z.array(id).max(20),
      idempotency_key: id,
    })
    .strict(),
  factory_request_verification: z
    .object({
      job_id: id,
      attempt_id: id,
      lease_id: id,
      candidate_commit: commit,
      verification_profile_id: id,
      idempotency_key: id,
    })
    .strict(),
  factory_submit_candidate: z
    .object({
      job_id: id,
      attempt_id: id,
      lease_id: id,
      candidate_commit: commit,
      verification_id: id,
      change_summary: z.string().min(1).max(4000),
      artifact_manifest: z.array(artifact).max(100),
      idempotency_key: id,
    })
    .strict(),
};
export const results = {
  factory_status: status,
  factory_next_task: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("no_task"), retry_after: timestamp.optional() }),
    z.object({ kind: z.literal("assignment"), assignment }),
  ]),
  factory_request_verification: z.object({
    verification_id: id,
    status: z.enum(["queued", "running"]),
  }),
  factory_submit_candidate: z.object({
    status: z.enum(["accepted_for_integration", "needs_rework", "blocked"]),
    reasons: z.array(z.string().max(1000)).max(50),
    state_revision: z.number().int().nonnegative(),
  }),
};
export const errorCode = z.enum([
  "validation_failed",
  "policy_denied",
  "stale_lease",
  "provider_cooldown",
  "controller_unavailable",
  "unsupported_capability",
  "incompatible_version",
  "outcome_unknown",
  "idempotency_conflict",
]);
export const wireError = z.object({
  code: errorCode,
  retry_after: timestamp.optional(),
});
export const envelope = z
  .object({
    protocol_version: z.literal(VERSION),
    request_id: id,
    project_id: id,
    session_id: id,
    result: z.unknown().optional(),
    error: wireError.optional(),
  })
  .superRefine((v, c) => {
    if ((v.result === undefined) === (v.error === undefined))
      c.addIssue({
        code: "custom",
        message: "Exactly one result or error required",
      });
  });
export const reconciliation = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("complete"),
    payload: z.record(z.string(), z.unknown()),
    response: envelope,
  }),
]);
export type Operation = (typeof operations)[number];
export type Assignment = z.infer<typeof assignment>;
export class BridgeError extends Error {
  definitive = false;
  retry_after?: string;
  constructor(
    public code: z.infer<typeof errorCode>,
    public request_id?: string,
    public last_known_timestamp?: string,
  ) {
    super(code);
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        request_id: this.request_id,
        last_known_timestamp: this.last_known_timestamp,
        retry_after: this.retry_after,
      },
    };
  }
}
