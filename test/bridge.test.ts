import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryClient, endpoint } from "../src/client.js";
import { operations, BridgeError, VERSION, results } from "../src/protocol.js";
import { assigned, cap, state, inputs, sha } from "./fixtures.js";

async function fixture(t: any) {
  const worktree = await mkdtemp(join(tmpdir(), "factory-test-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  let capabilities: any = structuredClone(cap);
  let current: any = structuredClone(state(worktree));
  let disconnect = false,
    drop = false,
    malformed = false,
    pending = false;
  const effects = new Map<string, any>();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (disconnect) throw new Error("secret-token must not escape");
    if (path === "/v1/capabilities") return Response.json(capabilities);
    if (path.startsWith("/v1/requests/")) {
      const stored = effects.get(path.split("/").at(-1)!);
      return Response.json(
        pending
          ? { status: "pending" }
          : stored
            ? { status: "complete", ...stored }
            : { status: "not_found" },
      );
    }
    const body = JSON.parse(String(options?.body));
    let result: any;
    switch (path) {
      case "/v1/factory_status":
        result = current;
        break;
      case "/v1/factory_next_task":
        result = { kind: "assignment", assignment: assigned(worktree) };
        break;
      case "/v1/factory_request_verification":
        result = { verification_id: "verification-1", status: "queued" };
        break;
      case "/v1/factory_submit_candidate":
        result = {
          status: "accepted_for_integration",
          reasons: [],
          state_revision: 2,
        };
        break;
      default:
        throw Error(path);
    }
    const response = {
      protocol_version: VERSION,
      request_id: body.request_id,
      project_id: body.project_id,
      session_id: body.session_id,
      result,
    };
    if (path !== "/v1/factory_status")
      effects.set(body.request_id, { payload: body, response });
    if (drop && path !== "/v1/factory_status") {
      drop = false;
      throw new Error("socket lost after commit");
    }
    return Response.json(
      malformed ? { ...response, project_id: "other" } : response,
    );
  };
  const client = () =>
    new FactoryClient(
      { endpoint: "http://127.0.0.1:4321", project_id: "project-1", worktree },
      fetcher,
    );
  const ctx = {
    sessionID: "session-1",
    worktree,
    abort: new AbortController().signal,
  };
  return {
    worktree,
    ctx,
    client,
    calls,
    effects,
    get current() {
      return current;
    },
    set current(v) {
      current = v;
    },
    get capabilities() {
      return capabilities;
    },
    set capabilities(v) {
      capabilities = v;
    },
    disconnect() {
      disconnect = true;
    },
    drop() {
      drop = true;
    },
    malformed() {
      malformed = true;
    },
    pending() {
      pending = true;
    },
  };
}
const code = (expected: string) => (e: any) =>
  e instanceof BridgeError && e.code === expected;
for (const op of operations)
  test(`${op} validates a successful contract response`, async (t) => {
    const f = await fixture(t);
    assert.ok(
      results[op].safeParse(await f.client().call(op, inputs[op], f.ctx))
        .success,
    );
  });
for (const exitStatus of [-1, 1])
  test(`passed receipt with command exit ${exitStatus} is rejected`, async (t) => {
    const f = await fixture(t);
    f.current.active_verification_receipt.commands.push({
      command: "runtime check",
      exit_status: exitStatus,
    });
    await assert.rejects(
      f.client().call("factory_status", inputs.factory_status, f.ctx),
      code("validation_failed"),
    );
  });
test("failed receipt preserves nonzero commands for rework", async (t) => {
  const f = await fixture(t);
  f.current.active_verification_receipt.outcome = "failed";
  f.current.active_verification_receipt.commands[0].exit_status = 7;
  const result = await f
    .client()
    .call("factory_status", inputs.factory_status, f.ctx);
  assert.equal(result.active_verification_receipt?.outcome, "failed");
  assert.equal(result.active_verification_receipt?.commands[0].exit_status, 7);
});
for (const op of operations.filter((op) => op !== "factory_status"))
  test(`${op} reconciles a lost response after restart with one effect`, async (t) => {
    const f = await fixture(t);
    f.drop();
    await assert.rejects(
      f.client().call(op, inputs[op], f.ctx),
      code("outcome_unknown"),
    );
    const first = f.effects.keys().next().value;
    const result = await f.client().call(op, inputs[op], f.ctx);
    assert.ok(result);
    assert.equal(f.effects.size, 1);
    assert.equal(f.effects.keys().next().value, first);
    assert.equal(f.calls.filter((x) => x === "/v1/" + op).length, 1);
  });
test("same key with different content conflicts", async (t) => {
  const f = await fixture(t);
  await f
    .client()
    .call("factory_submit_candidate", inputs.factory_submit_candidate, f.ctx);
  await assert.rejects(
    f
      .client()
      .call(
        "factory_submit_candidate",
        { ...inputs.factory_submit_candidate, change_summary: "Different" },
        f.ctx,
      ),
    code("idempotency_conflict"),
  );
});
test("wrong project and session rejected before network", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.client().call("factory_status", { project_id: "other" }, f.ctx),
    code("policy_denied"),
  );
  await assert.rejects(
    f
      .client()
      .call(
        "factory_next_task",
        { ...inputs.factory_next_task, session_id: "other" },
        f.ctx,
      ),
    code("policy_denied"),
  );
  assert.equal(f.calls.length, 0);
});
test("changed worktree rejected before network", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.client().call("factory_status", inputs.factory_status, {
      ...f.ctx,
      worktree: tmpdir(),
    }),
    code("policy_denied"),
  );
  assert.equal(f.calls.length, 0);
});
test("stale lease never dispatches verification", async (t) => {
  const f = await fixture(t);
  f.current.current_attempt.lease_expires_at = "2000-01-01T00:00:00Z";
  await assert.rejects(
    f
      .client()
      .call(
        "factory_request_verification",
        inputs.factory_request_verification,
        f.ctx,
      ),
    code("stale_lease"),
  );
  assert.ok(!f.calls.includes("/v1/factory_request_verification"));
});
test("wrong attempt rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f
      .client()
      .call(
        "factory_request_verification",
        { ...inputs.factory_request_verification, attempt_id: "other" },
        f.ctx,
      ),
    code("stale_lease"),
  );
});
test("evidence for commit A cannot submit B", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.client().call(
      "factory_submit_candidate",
      {
        ...inputs.factory_submit_candidate,
        candidate_commit: "c".repeat(40),
      },
      f.ctx,
    ),
    code("policy_denied"),
  );
});
test("malformed receipt fails safely", async (t) => {
  const f = await fixture(t);
  delete f.current.active_verification_receipt.environment_id;
  await assert.rejects(
    f.client().call("factory_status", inputs.factory_status, f.ctx),
    code("validation_failed"),
  );
});
test("unregistered profile never dispatches", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.client().call(
      "factory_request_verification",
      {
        ...inputs.factory_request_verification,
        verification_profile_id: "shell",
      },
      f.ctx,
    ),
    code("unsupported_capability"),
  );
});
test("protected checks blocked by controller are surfaced", async (t) => {
  const f = await fixture(t);
  f.current.state = "blocked";
  f.current.blockers = ["Protected verification files changed"];
  f.current.permitted_next_actions = ["factory_status"];
  const c = f.client();
  assert.equal(
    (await c.call("factory_status", inputs.factory_status, f.ctx)).blockers[0],
    "Protected verification files changed",
  );
  await assert.rejects(
    c.call("factory_submit_candidate", inputs.factory_submit_candidate, f.ctx),
    code("policy_denied"),
  );
});
test("cooldown and retry timestamp retained", async (t) => {
  const f = await fixture(t);
  f.current.state = "retry_wait";
  f.current.blockers = ["provider_cooldown"];
  f.current.next_retry_at = "2099-01-01T00:00:00Z";
  assert.equal(
    (await f.client().call("factory_status", inputs.factory_status, f.ctx))
      .next_retry_at,
    f.current.next_retry_at,
  );
});
test("disconnection returns timestamp without leaking exception secrets", async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.call("factory_status", inputs.factory_status, f.ctx);
  f.disconnect();
  await assert.rejects(
    c.call("factory_status", inputs.factory_status, f.ctx),
    (e: any) => {
      assert.equal(e.last_known_timestamp, f.current.freshness_timestamp);
      assert.ok(!JSON.stringify(e.toJSON()).includes("secret-token"));
      return e.code === "controller_unavailable";
    },
  );
});
test("incompatible version and missing capability fail before dispatch", async (t) => {
  const f = await fixture(t);
  f.capabilities.protocol_max = "1.0";
  await assert.rejects(
    f.client().call("factory_next_task", inputs.factory_next_task, f.ctx),
    code("incompatible_version"),
  );
  f.capabilities = structuredClone(cap);
  f.capabilities.operations = ["factory_status"];
  await assert.rejects(
    f.client().call("factory_next_task", inputs.factory_next_task, f.ctx),
    code("unsupported_capability"),
  );
  assert.ok(!f.calls.includes("/v1/factory_next_task"));
});
test("pending reconciliation does not resend write", async (t) => {
  const f = await fixture(t);
  f.pending();
  await assert.rejects(
    f.client().call("factory_next_task", inputs.factory_next_task, f.ctx),
    code("outcome_unknown"),
  );
  assert.ok(!f.calls.includes("/v1/factory_next_task"));
});
test("response project assertion rejected", async (t) => {
  const f = await fixture(t);
  f.malformed();
  await assert.rejects(
    f.client().call("factory_status", inputs.factory_status, f.ctx),
    code("validation_failed"),
  );
});
test("arbitrary commands and completion arguments rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f
      .client()
      .call(
        "factory_request_verification",
        { ...inputs.factory_request_verification, command: "true" },
        f.ctx,
      ),
    code("validation_failed"),
  );
  await assert.rejects(
    f
      .client()
      .call(
        "factory_submit_candidate",
        { ...inputs.factory_submit_candidate, done: true },
        f.ctx,
      ),
    code("validation_failed"),
  );
});
test("done without delivery evidence rejected", async (t) => {
  const f = await fixture(t);
  f.current.state = "done";
  await assert.rejects(
    f.client().call("factory_status", inputs.factory_status, f.ctx),
    code("validation_failed"),
  );
});
test("endpoint rejects remote hosts, credentials and redirects in configuration", () => {
  for (const url of [
    "https://127.0.0.1:1",
    "http://example.com",
    "http://user:secret@127.0.0.1",
    "http://127.0.0.1/path",
    "http://localhost",
  ])
    assert.throws(() => endpoint(url));
  assert.equal(endpoint("http://[::1]:1234"), "http://[::1]:1234");
});
test("expired assignment remains inspectable in status", async (t) => {
  const f = await fixture(t);
  f.current.current_attempt.lease_expires_at = "2000-01-01T00:00:00Z";
  assert.equal(
    (await f.client().call("factory_status", inputs.factory_status, f.ctx))
      .state,
    "running",
  );
});
test("no_task result validates without inventing assignment", () =>
  assert.ok(
    results.factory_next_task.safeParse({
      kind: "no_task",
      retry_after: "2099-01-01T00:00:00Z",
    }).success,
  ));
test("submission result cannot claim final completion", () =>
  assert.equal(
    results.factory_submit_candidate.safeParse({
      status: "done",
      reasons: [],
      state_revision: 2,
    }).success,
    false,
  ));
test("definitive controller validation rejection stays validation_failed", async (t) => {
  const f = await fixture(t);
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/capabilities") return Response.json(cap);
    if (path.startsWith("/v1/requests/"))
      return Response.json({ status: "not_found" });
    const body = JSON.parse(String(options?.body));
    return Response.json(
      {
        protocol_version: VERSION,
        request_id: body.request_id,
        project_id: body.project_id,
        session_id: body.session_id,
        error: { code: "validation_failed" },
      },
      { status: 422 },
    );
  };
  const client = new FactoryClient(
    {
      endpoint: "http://127.0.0.1:4321",
      project_id: "project-1",
      worktree: f.worktree,
    },
    fetcher,
  );
  await assert.rejects(
    client.call("factory_next_task", inputs.factory_next_task, f.ctx),
    code("validation_failed"),
  );
});
