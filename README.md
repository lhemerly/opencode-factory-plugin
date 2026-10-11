# OpenCode Factory Plugin

A TypeScript plugin for code factories. It brings approved assignments, task status, verification requests and candidate handoffs into OpenCode through a small controller bridge.

The plugin uses OpenCode's existing interface. A separately deployed controller owns the durable queue, leases, independent verification, integration and final acceptance. The plugin never marks a job complete and never supplies arbitrary verifier commands.

## Compatibility

- OpenCode and `@opencode-ai/plugin`: **1.19.0**
- Controller protocol: **0.1 only**
- Development: Node.js 22 or newer
- Transport: JSON over HTTP on `127.0.0.1` or `::1`

This release implements the consumer bridge and includes contract fixtures, HTTP lifecycle tests and a pinned OpenCode loading test. A production controller is not included. Real verification and delivery require an independent controller implementing [the wire contract](docs/protocol.md). No production end-to-end acceptance claim is made.

## Install from source

```sh
git clone https://github.com/lhemerly/opencode-factory-plugin.git
cd opencode-factory-plugin
npm ci
npm run build
```

Add the built module to your trusted OpenCode configuration using its absolute file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/opencode-factory-plugin/dist/index.js"]
}
```

Load the compiled entry once; do not also copy it into a plugin directory. OpenCode's [plugin documentation](https://opencode.ai/docs/plugins/) describes file and package loading. npm publication is not required and this repository does not claim an npm release.

Set the host-managed environment before starting OpenCode:

```sh
export FACTORY_ENABLED=1
export FACTORY_PROJECT_ID=example-project
export FACTORY_CONTROLLER_URL=http://127.0.0.1:4317
export FACTORY_TIMEOUT_MS=10000
opencode
```

`FACTORY_ENABLED` must equal `1`. Otherwise the plugin registers no hooks or tools and makes no controller requests. `FACTORY_PROJECT_ID` and `FACTORY_CONTROLLER_URL` are required when enabled. The host's OpenCode worktree is the permitted worktree. Symlinks are resolved before comparing bindings. The timeout must be an integer from 1 to 120000 milliseconds.

The first deployment assumes a deliberately configured local trust boundary. For a scoped controller capability, inject `FACTORY_TOKEN` through the host environment; it is sent only as an HTTP authorization header. Never put credentials in tool arguments, repository files or prompts. Remote endpoints, URL credentials, redirects and controller URL paths are rejected. Local HTTP does not isolate OS processes or grant a sandbox.

## Tools

| Tool                           | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `factory_status`               | Read current state, freshness, blockers and exact verification evidence |
| `factory_next_task`            | Claim already-approved work for this session and worktree               |
| `factory_request_verification` | Request verification of an exact commit with a registered profile       |
| `factory_submit_candidate`     | Submit a candidate with a passed receipt for integration                |

A normal flow is to claim an assignment, read its task brief and acceptance criteria, develop in its bound worktree, request verification of a full commit hash, inspect the receipt with `factory_status`, then submit that exact candidate with its artifact manifest. Controller decisions such as `blocked`, `needs_rework` and `retry_wait` remain visible to the agent.

Each write needs a caller-chosen `idempotency_key`. Keep that key and the arguments unchanged when reconciling a timeout. The bridge derives the same request identity after restart and queries the controller before another dispatch. A completed matching request returns its original result; different arguments conflict; a pending request returns `outcome_unknown`. No write is retried automatically. The controller must persist idempotency and state transitions atomically.

Session idle events refresh status only. Session deletion cancels its pending requests. Plugin disposal cancels all pending requests. Neither an idle event nor an agent's completion message changes controller state.

## Development

```sh
npm run check
npm test
npm run schemas
npm run test:runtime
npm pack
```

Tests cover contract validation, wrong project/session/worktree assertions, stale leases, unsupported profiles, mismatched commits, timeout reconciliation across restart, idempotency conflicts, controller disconnection, cancellation, disposal, response bounds and pinned runtime loading. See [validation scope](docs/validation.md) for the limits of this evidence.

JSON Schemas are checked in under `schemas/`; sanitized example fixtures are under `examples/fixtures/`. [Protocol details](docs/protocol.md) specify endpoints and controller responsibilities. [MIT license](LICENSE); see [dependency notices](THIRD_PARTY_NOTICES.md).
