import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = await mkdtemp(join(tmpdir(), "factory-opencode-"));
await mkdir(join(root, "config"));
await mkdir(join(root, "workspace"));
await writeFile(
  join(root, "config.json"),
  JSON.stringify({
    plugin: [pathToFileURL(resolve("dist/index.js")).href],
    provider: {},
    autoupdate: false,
  }),
);
const proc = spawn(
  resolve("node_modules/.bin/opencode"),
  ["serve", "--port", "0", "--hostname", "127.0.0.1"],
  {
    cwd: join(root, "workspace"),
    env: {
      ...process.env,
      FACTORY_ENABLED: "1",
      FACTORY_PROJECT_ID: "smoke",
      FACTORY_CONTROLLER_URL: "http://127.0.0.1:4321",
      OPENCODE_CONFIG: join(root, "config.json"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
proc.stdout.on("data", (b) => (output += b));
proc.stderr.on("data", (b) => (output += b));
try {
  let base;
  for (let i = 0; i < 200; i++) {
    base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (base) break;
    if (proc.exitCode !== null) throw Error("OpenCode exited: " + output);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(base, "Server startup timed out: " + output);
  const response = await fetch(
    base +
      "/experimental/tool/ids?directory=" +
      encodeURIComponent(join(root, "workspace")),
    { signal: AbortSignal.timeout(60000) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const ids = await response.json();
  for (const name of [
    "factory_status",
    "factory_next_task",
    "factory_request_verification",
    "factory_submit_candidate",
  ])
    assert.ok(
      ids.includes(name),
      "Missing " + name + ": " + JSON.stringify(ids) + "\n" + output,
    );
  // Disposing the instance exercises the pinned runtime's plugin dispose path.
  const disposed = await fetch(
    base +
      "/instance/dispose?directory=" +
      encodeURIComponent(join(root, "workspace")),
    { method: "POST" },
  );
  assert.equal(disposed.status, 200);
  console.log(
    "OpenCode 1.19.0: all four factory tools loaded; instance disposal succeeded.",
  );
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) =>
    proc.exitCode !== null ? r() : proc.once("exit", r),
  );
  await rm(root, { recursive: true, force: true });
}
