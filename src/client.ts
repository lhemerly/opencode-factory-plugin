import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  VERSION,
  BridgeError,
  args,
  capabilities,
  envelope,
  reconciliation,
  results,
  type Operation,
  type Assignment,
} from "./protocol.js";
export type Config = {
  endpoint: string;
  project_id: string;
  worktree: string;
  timeout_ms?: number;
  token?: string;
};
export type Context = {
  sessionID: string;
  worktree: string;
  abort: AbortSignal;
};
export function endpoint(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new BridgeError("policy_denied");
  return u.origin;
}
export class FactoryClient {
  private url: string;
  private pending = new Set<AbortController>();
  private disposed = false;
  private freshness = new Map<string, string>();
  private sessions = new Map<string, Set<AbortController>>();
  constructor(
    private config: Config,
    private fetcher: typeof fetch = fetch,
  ) {
    this.url = endpoint(config.endpoint);
    z.string().min(1).max(200).parse(config.project_id);
    if (
      !Number.isInteger(config.timeout_ms ?? 10000) ||
      (config.timeout_ms ?? 10000) < 1 ||
      (config.timeout_ms ?? 10000) > 120000
    )
      throw new BridgeError("validation_failed");
  }
  cancelSession(session: string) {
    for (const c of this.sessions.get(session) ?? []) c.abort();
    this.sessions.delete(session);
  }
  dispose() {
    this.disposed = true;
    for (const session of this.sessions.keys()) this.cancelSession(session);
    for (const c of this.pending) c.abort();
    this.pending.clear();
  }
  private async http(
    path: string,
    body: unknown,
    signal: AbortSignal,
    requestID: string,
    write = false,
  ) {
    if (this.disposed)
      throw new BridgeError("controller_unavailable", requestID);
    const c = new AbortController();
    this.pending.add(c);
    const combined = AbortSignal.any([
      signal,
      c.signal,
      AbortSignal.timeout(this.config.timeout_ms ?? 10000),
    ]);
    try {
      const r = await this.fetcher(this.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.token
            ? { authorization: `Bearer ${this.config.token}` }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: "error",
      });
      // Bounded streaming avoids allowing controller output to exhaust the session.
      const reader = r.body?.getReader();
      if (!reader) throw new Error("empty");
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) {
          await reader.cancel();
          throw new BridgeError("validation_failed", requestID);
        }
        chunks.push(value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!r.ok) {
        const parsed = envelope.safeParse(value);
        if (
          parsed.success &&
          parsed.data.request_id === requestID &&
          parsed.data.project_id === this.config.project_id &&
          parsed.data.session_id ===
            (body && typeof body === "object" && "session_id" in body
              ? body.session_id
              : new URL(this.url + path).searchParams.get("session_id")) &&
          parsed.data.error
        ) {
          const error = new BridgeError(parsed.data.error.code, requestID);
          error.definitive = true;
          error.retry_after = parsed.data.error.retry_after;
          throw error;
        }
        throw new BridgeError("validation_failed", requestID);
      }
      return value;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError(
        write ? "outcome_unknown" : "controller_unavailable",
        requestID,
      );
    } finally {
      this.pending.delete(c);
    }
  }
  private decode(
    op: Operation,
    value: unknown,
    requestID: string,
    session: string,
  ) {
    const e = envelope.safeParse(value);
    if (
      !e.success ||
      e.data.request_id !== requestID ||
      e.data.project_id !== this.config.project_id ||
      e.data.session_id !== session
    )
      throw new BridgeError("validation_failed", requestID);
    if (e.data.error) {
      const error = new BridgeError(e.data.error.code, requestID);
      error.definitive = true;
      error.retry_after = e.data.error.retry_after;
      throw error;
    }
    const result = results[op].safeParse(e.data.result);
    if (!result.success) throw new BridgeError("validation_failed", requestID);
    return result.data;
  }
  private async binding(a: Assignment, ctx: Context, enforceLease = true) {
    if (
      a.session_id !== ctx.sessionID ||
      (await realpath(a.worktree_binding)) !==
        (await realpath(this.config.worktree)) ||
      (await realpath(ctx.worktree)) !== (await realpath(this.config.worktree))
    )
      throw new BridgeError("policy_denied");
    if (enforceLease && Date.parse(a.lease_expires_at) <= Date.now())
      throw new BridgeError("stale_lease");
  }
  async call<O extends Operation>(
    op: O,
    input: unknown,
    ctx: Context,
  ): Promise<z.infer<(typeof results)[O]>> {
    const c = new AbortController();
    const group =
      this.sessions.get(ctx.sessionID) ?? new Set<AbortController>();
    group.add(c);
    this.sessions.set(ctx.sessionID, group);
    try {
      return await this.perform(op, input, {
        ...ctx,
        abort: AbortSignal.any([ctx.abort, c.signal]),
      });
    } catch (e) {
      if (e instanceof BridgeError) {
        if (e.code === "controller_unavailable")
          e.last_known_timestamp = this.freshness.get(ctx.sessionID);
        throw e;
      }
      throw new BridgeError("validation_failed");
    } finally {
      group.delete(c);
      if (!group.size) this.sessions.delete(ctx.sessionID);
    }
  }
  private async perform(
    op: Operation,
    input: unknown,
    ctx: Context,
  ): Promise<any> {
    const parsed = args[op].safeParse(input);
    if (!parsed.success) throw new BridgeError("validation_failed");
    const a = parsed.data as Record<string, any>;
    if (
      (a.project_id && a.project_id !== this.config.project_id) ||
      (a.session_id && a.session_id !== ctx.sessionID)
    )
      throw new BridgeError("policy_denied");
    if (
      (await realpath(ctx.worktree)) !== (await realpath(this.config.worktree))
    )
      throw new BridgeError("policy_denied");
    const requestID = createHash("sha256")
      .update(
        JSON.stringify([
          VERSION,
          this.config.project_id,
          ctx.sessionID,
          op,
          a.idempotency_key ?? crypto.randomUUID(),
        ]),
      )
      .digest("hex");
    const cap = capabilities.safeParse(
      await this.http(
        `/v1/capabilities?protocol_version=${VERSION}&request_id=${requestID}&project_id=${encodeURIComponent(this.config.project_id)}&session_id=${encodeURIComponent(ctx.sessionID)}`,
        undefined,
        ctx.abort,
        requestID,
      ),
    );
    if (!cap.success) throw new BridgeError("incompatible_version", requestID);
    if (
      !cap.data.operations.includes(op) ||
      !cap.data.worker_adapters.includes("opencode")
    )
      throw new BridgeError("unsupported_capability", requestID);
    const write = op !== "factory_status";
    const payload = {
      ...a,
      protocol_version: VERSION,
      request_id: requestID,
      project_id: this.config.project_id,
      session_id: ctx.sessionID,
    };
    if (write) {
      const q = reconciliation.safeParse(
        await this.http(
          `/v1/requests/${requestID}?project_id=${encodeURIComponent(this.config.project_id)}&session_id=${encodeURIComponent(ctx.sessionID)}&protocol_version=${VERSION}`,
          undefined,
          ctx.abort,
          requestID,
        ),
      );
      if (!q.success) throw new BridgeError("validation_failed", requestID);
      if (q.data.status === "pending")
        throw new BridgeError("outcome_unknown", requestID);
      if (q.data.status === "complete") {
        const normalize = (v: any): any =>
          Array.isArray(v)
            ? v.map(normalize)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.keys(v)
                    .sort()
                    .map((k) => [k, normalize(v[k])]),
                )
              : v;
        const canonical = (v: Record<string, unknown>) =>
          JSON.stringify(normalize(v));
        if (canonical(q.data.payload) !== canonical(payload))
          throw new BridgeError("idempotency_conflict", requestID);
        return this.decode(op, q.data.response, requestID, ctx.sessionID);
      }
    }
    if (
      op === "factory_request_verification" ||
      op === "factory_submit_candidate"
    ) {
      const state = await this.call(
        "factory_status",
        { project_id: this.config.project_id, job_id: a.job_id },
        ctx,
      );
      const assigned = state.current_attempt;
      if (!assigned) throw new BridgeError("stale_lease", requestID);
      await this.binding(assigned, ctx);
      if (
        assigned.job_id !== a.job_id ||
        assigned.attempt_id !== a.attempt_id ||
        assigned.lease_id !== a.lease_id
      )
        throw new BridgeError("stale_lease", requestID);
      if (!state.permitted_next_actions.includes(op))
        throw new BridgeError("policy_denied", requestID);
      if (
        op === "factory_request_verification" &&
        (!assigned.allowed_verification_profiles.includes(
          a.verification_profile_id,
        ) ||
          !cap.data.verification_profiles.includes(a.verification_profile_id))
      )
        throw new BridgeError("unsupported_capability", requestID);
      if (op === "factory_submit_candidate") {
        const receipt = state.active_verification_receipt;
        if (
          !receipt ||
          receipt.outcome !== "passed" ||
          receipt.verification_id !== a.verification_id ||
          receipt.candidate_commit !== a.candidate_commit
        )
          throw new BridgeError("policy_denied", requestID);
      }
    }
    let result;
    try {
      result = this.decode(
        op,
        await this.http("/v1/" + op, payload, ctx.abort, requestID, write),
        requestID,
        ctx.sessionID,
      );
    } catch (e) {
      if (
        write &&
        e instanceof BridgeError &&
        e.code === "validation_failed" &&
        !e.definitive
      )
        throw new BridgeError("outcome_unknown", requestID);
      if (e instanceof BridgeError && e.code === "controller_unavailable")
        e.last_known_timestamp = this.freshness.get(ctx.sessionID);
      throw e;
    }
    if (op === "factory_next_task") {
      const task = results.factory_next_task.parse(result);
      if (task.kind === "assignment") await this.binding(task.assignment, ctx);
    }
    if (op === "factory_status") {
      const state = results.factory_status.parse(result);
      if (
        a.job_id &&
        state.current_attempt &&
        state.current_attempt.job_id !== a.job_id
      )
        throw new BridgeError("policy_denied", requestID);
      if (state.current_attempt)
        await this.binding(state.current_attempt, ctx, false);
      this.freshness.set(ctx.sessionID, state.freshness_timestamp);
    }
    return result;
  }
}
