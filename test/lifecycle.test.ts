import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryClient } from "../src/client.js";
import { FactoryPlugin } from "../src/index.js";
import { cap, inputs, state } from "./fixtures.js";
import { VERSION } from "../src/protocol.js";

async function server(t: any, mode: string) {
  const worktree = await mkdtemp(join(tmpdir(), "factory-http-"));
  const seen: string[] = [];
  let signalPost!: () => void;
  const posted = new Promise<void>((r) => (signalPost = r));
  const app = createServer(async (req, res) => {
    seen.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url!.startsWith("/v1/capabilities")) {
      res.end(JSON.stringify(cap));
      return;
    }
    if (req.url!.startsWith("/v1/requests/")) {
      res.end('{"status":"not_found"}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    signalPost();
    if (mode === "hang") return;
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://example.com/secret" });
      res.end();
      return;
    }
    if (mode === "oversized") {
      res.end("x".repeat(262145));
      return;
    }
    res.end(
      JSON.stringify({
        protocol_version: VERSION,
        request_id: body.request_id,
        project_id: body.project_id,
        session_id: body.session_id,
        result: state(worktree),
      }),
    );
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const address = app.address() as any;
  t.after(async () => {
    app.closeAllConnections();
    await new Promise<void>((r) => app.close(() => r()));
    await rm(worktree, { recursive: true, force: true });
  });
  return {
    worktree,
    seen,
    posted,
    endpoint: `http://127.0.0.1:${address.port}`,
    ctx: {
      sessionID: "session-1",
      worktree,
      abort: new AbortController().signal,
    },
  };
}
test("real HTTP status roundtrip", async (t) => {
  const f = await server(t, "normal");
  const c = new FactoryClient({
    endpoint: f.endpoint,
    worktree: f.worktree,
    project_id: "project-1",
  });
  assert.equal(
    (await c.call("factory_status", inputs.factory_status, f.ctx)).state,
    "running",
  );
});
test("write timeout is outcome_unknown", async (t) => {
  const f = await server(t, "hang");
  const c = new FactoryClient({
    endpoint: f.endpoint,
    worktree: f.worktree,
    project_id: "project-1",
    timeout_ms: 100,
  });
  await assert.rejects(
    c.call("factory_next_task", inputs.factory_next_task, f.ctx),
    (e: any) => e.code === "outcome_unknown",
  );
});
for (const kind of ["abort", "dispose", "session_delete"])
  test(`${kind} cancels an in-flight write`, async (t) => {
    const f = await server(t, "hang");
    const c = new FactoryClient({
      endpoint: f.endpoint,
      worktree: f.worktree,
      project_id: "project-1",
    });
    const abort = new AbortController();
    const pending = c.call("factory_next_task", inputs.factory_next_task, {
      ...f.ctx,
      abort: abort.signal,
    });
    await f.posted;
    if (kind === "abort") abort.abort();
    else if (kind === "dispose") c.dispose();
    else c.cancelSession("session-1");
    await assert.rejects(pending, (e: any) => e.code === "outcome_unknown");
    if (kind === "dispose")
      await assert.rejects(
        c.call("factory_status", inputs.factory_status, f.ctx),
        (e: any) => e.code === "controller_unavailable",
      );
  });
for (const kind of ["redirect", "oversized"])
  test(`${kind} response fails closed`, async (t) => {
    const f = await server(t, kind);
    const c = new FactoryClient({
      endpoint: f.endpoint,
      worktree: f.worktree,
      project_id: "project-1",
    });
    await assert.rejects(
      c.call("factory_status", inputs.factory_status, f.ctx),
      (e: any) =>
        ["validation_failed", "controller_unavailable"].includes(e.code),
    );
  });
test("disabled plugin adds no tools", async () => {
  const old = process.env.FACTORY_ENABLED;
  delete process.env.FACTORY_ENABLED;
  try {
    assert.deepEqual(await FactoryPlugin({} as any), {});
  } finally {
    if (old !== undefined) process.env.FACTORY_ENABLED = old;
  }
});
test("plugin tools load, duplicate idle is read-only, dispose closes bridge", async (t) => {
  const f = await server(t, "normal");
  const old = { ...process.env };
  Object.assign(process.env, {
    FACTORY_ENABLED: "1",
    FACTORY_PROJECT_ID: "project-1",
    FACTORY_CONTROLLER_URL: f.endpoint,
  });
  try {
    const hooks = await FactoryPlugin({ worktree: f.worktree } as any);
    assert.equal(Object.keys(hooks.tool!).length, 4);
    for (let i = 0; i < 2; i++)
      await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "session-1" } },
      });
    assert.ok(!f.seen.some((x) => x.includes("factory_submit_candidate")));
    assert.equal(f.seen.filter((x) => x === "/v1/factory_status").length, 2);
    await hooks.dispose!();
    const output = await hooks.tool!.factory_status.execute(
      inputs.factory_status,
      f.ctx as any,
    );
    assert.equal(
      JSON.parse(String(output)).error.code,
      "controller_unavailable",
    );
  } finally {
    for (const k of [
      "FACTORY_ENABLED",
      "FACTORY_PROJECT_ID",
      "FACTORY_CONTROLLER_URL",
    ]) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
});
