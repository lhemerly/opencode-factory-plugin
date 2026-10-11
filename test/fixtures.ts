import { operations, VERSION } from "../src/protocol.js";
export const sha = "a".repeat(40);
export const assigned = (worktree: string) => ({
  job_id: "job-1",
  attempt_id: "attempt-1",
  lease_id: "lease-1",
  session_id: "session-1",
  lease_expires_at: "2099-01-01T00:00:00Z",
  repository_id: "repo-1",
  approved_base_commit: sha,
  worktree_binding: worktree,
  task_brief: "Implement the approved change.",
  acceptance_criteria: ["Registered checks pass"],
  protected_paths: ["tests/acceptance"],
  allowed_verification_profiles: ["unit"],
  limits: { max_attempts: 3, timeout_seconds: 60 },
  policy_version: "1",
});
export const evidence = {
  verification_id: "verification-1",
  candidate_commit: sha,
  verification_profile_id: "unit",
  profile_version: "1",
  environment_id: "clean-checkout",
  outcome: "passed",
  commands: [{ command: "npm test", exit_status: 0 }],
  artifacts: [{ reference: "artifact:test-log", sha256: "b".repeat(64) }],
};
export const cap = {
  protocol_min: VERSION,
  protocol_max: VERSION,
  operations: [...operations],
  worker_adapters: ["opencode"],
  verification_profiles: ["unit"],
};
export const state = (worktree: string) => ({
  state: "running",
  state_revision: 1,
  current_attempt: assigned(worktree),
  permitted_next_actions: [...operations],
  blockers: [],
  active_verification_receipt: evidence,
  delivery_reference: null,
  freshness_timestamp: "2026-10-11T21:00:00Z",
  next_retry_at: null,
  outcome: null,
});
export const inputs = {
  factory_status: { project_id: "project-1", job_id: "job-1" },
  factory_next_task: {
    project_id: "project-1",
    session_id: "session-1",
    adapter_capabilities: ["opencode"],
    idempotency_key: "claim-1",
  },
  factory_request_verification: {
    job_id: "job-1",
    attempt_id: "attempt-1",
    lease_id: "lease-1",
    candidate_commit: sha,
    verification_profile_id: "unit",
    idempotency_key: "verify-1",
  },
  factory_submit_candidate: {
    job_id: "job-1",
    attempt_id: "attempt-1",
    lease_id: "lease-1",
    candidate_commit: sha,
    verification_id: "verification-1",
    change_summary: "Implemented the approved change.",
    artifact_manifest: evidence.artifacts,
    idempotency_key: "submit-1",
  },
};
