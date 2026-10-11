# Controller bridge protocol 0.1

This document defines the concrete wire mapping used by this plugin for code factories. Controller implementations must support the exact mapping before deployment. Internal queue, verifier and integrator implementations remain independent.

## Transport and host authority

The configured endpoint is an HTTP loopback origin without credentials, query, fragment or path. Requests reject redirects. The host fixes the project and worktree; tool-supplied IDs are assertions, never grants. The controller must also enforce the capability's permitted project, job, session, repository and lease. A worktree binding is a canonical local filesystem path, not a filesystem sandbox.

Requests have `Content-Type: application/json`; a configured token becomes `Authorization: Bearer …`. Responses are streamed with a 256 KiB limit and bounded field/array schemas. Unknown additive response fields are stripped before presentation. Raw exceptions, response bodies and credentials are not logged or included in error messages.

## Endpoints

| Method and path                                                                    | Request                                     | Response                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `GET /v1/capabilities?protocol_version=0.1&request_id=…&project_id=…&session_id=…` | Host authorization and scope assertions     | Capability catalog                   |
| `GET /v1/requests/{request_id}?project_id=…&session_id=…&protocol_version=0.1`     | Host scope assertions                       | Reconciliation record                |
| `POST /v1/factory_status`                                                          | Status arguments plus envelope fields       | Status result envelope; read-only    |
| `POST /v1/factory_next_task`                                                       | Claim arguments plus envelope fields        | Assignment or no-task envelope       |
| `POST /v1/factory_request_verification`                                            | Verification arguments plus envelope fields | Queued/running verification envelope |
| `POST /v1/factory_submit_candidate`                                                | Candidate arguments plus envelope fields    | Integration/rework/blocked envelope  |

The capability response contains `protocol_min`, `protocol_max`, `operations`, `worker_adapters` and `verification_profiles`. Both version bounds must be `0.1`; the adapter catalog must include `opencode`. Missing operations or profiles return `unsupported_capability`. Version mismatches fail without guessing another endpoint.

Every POST includes `protocol_version`, `request_id`, `project_id` and `session_id`. Operation-specific arguments add job, attempt and lease IDs where relevant. The bridge overwrites host scope fields after validating assertions.

Every response envelope contains those same four identity fields and exactly one of `result` or `error`. The error contains a documented `code` and optional ISO `retry_after`. Controller-provided free-form error messages are deliberately excluded from model-visible errors. A non-2xx response may return a validated error envelope; other non-2xx responses fail validation.

The checked-in `*.arguments.json` schemas describe agent arguments; `*.request.json` describes the complete POST payload including host scope fields. `envelope.json` describes response envelopes. Result bodies are `*.response.json`. The executable runtime schemas in `src/protocol.ts` are the consumer definition; regenerate exported schemas with `npm run schemas`. Runtime semantic checks additionally enforce completed-state evidence; these cross-field checks are not fully represented by exported JSON Schema. ISO timestamps use UTC; commit IDs are full lowercase SHA-1 or SHA-256 Git object IDs.

## Idempotency and reconciliation

Request identity is SHA-256 of the JSON array `["0.1", project_id, session_id, operation, idempotency_key]`. Read-only status requests use a random UUID in the final position. This preserves write identity across process restarts without a local job database.

The controller atomically commits the canonical request payload, logical effect, response and job transition. Keys must be scoped to the authenticated project, session and operation. The controller must reject a reused key with different canonical content, including simultaneous requests.

Before every write, the bridge queries the request record. Responses are:

```json
{ "status": "not_found" }
```

```json
{ "status": "pending" }
```

```json
{
  "status": "complete",
  "payload": {
    "protocol_version": "0.1",
    "request_id": "…",
    "project_id": "…",
    "session_id": "…"
  },
  "response": {
    "protocol_version": "0.1",
    "request_id": "…",
    "project_id": "…",
    "session_id": "…",
    "result": {}
  }
}
```

The complete record must contain the **entire original POST payload**, including operation arguments, and the original response envelope. Comparison sorts object keys recursively and preserves array order. Matching records return the original result without rechecking the now-changed lease or dispatching another write. Different content yields `idempotency_conflict`. Pending records yield `outcome_unknown`; the caller can query again with the same key. A failed reconciliation read prevents dispatch.

A timeout, cancellation, dropped connection, malformed successful write response or oversized successful write response means `outcome_unknown`. Keep the original key. A request ID alone does not prove a write succeeded or failed.

## Assignment and evidence

Assignments include job/attempt/lease/session IDs, lease expiry, repository identity, approved base commit, worktree binding, bounded task brief, acceptance criteria, protected paths, allowed profiles, execution limits and policy version. An assignment may only come from already-approved work. The controller owns admission and atomic lease allocation.

Before verification or candidate submission, the bridge reads authoritative status and checks the active assignment, unexpired lease, current worktree and permitted action. Verification additionally checks the profile against both assignment and capabilities. No command argument exists.

Candidate submission requires a passed active receipt for the same verification ID and exact candidate commit. Receipt fields include profile/version, environment identity, commands and exit statuses, artifact references and outcome. The controller must independently verify candidate ancestry, scope, protected files, manifest integrity, receipt authenticity and freshness; local checks are consumer guardrails.

Only the controller can decide final acceptance after integrating and verifying delivery. `factory_submit_candidate` returns `accepted_for_integration`, `needs_rework` or `blocked`, with reasons and revision. It cannot return `done`. Status supports `queued`, `running`, `verifying`, `blocked`, `retry_wait`, `paused` and `done`; a completed status must include passed evidence and a delivery reference. Cancellation or exhausted retries use a separate outcome and must not look successful.

## Errors and lifecycle

Codes: `validation_failed`, `policy_denied`, `stale_lease`, `provider_cooldown`, `controller_unavailable`, `unsupported_capability`, `incompatible_version`, `outcome_unknown`, `idempotency_conflict`.

Plugin-generated errors contain a code, request identity when known, and the last-known freshness timestamp on disconnection when available. This timestamp is not a healthy cached state. Errors intentionally do not reproduce arbitrary controller or transport messages.

Cancellation propagates through each HTTP request. Session deletion cancels that session's pending requests; disposal cancels all requests and stops further use. Session idle refreshes status, never completion. Duplicate idle events produce only duplicate reads. Durable recovery, lease renewal, integration reconciliation and delivery belong to the controller.
