// Orgo computers: create, observe, start, stop, delete. Actions call Orgo;
// queries read the component's last observation. Every function that takes
// a computerId checks it belongs to the caller's userKey before anything
// else, so one user cannot reach another's computer through a shared key.
import { v, type Infer } from "convex/values";
import {
  action,
  env,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import schema, { computerFields, operationValidator } from "./schema.js";
import {
  clampLimit,
  isOrgoError,
  orgoError,
  orgoId,
  orgoJson,
  outcomeUnknown,
  resolveConfig,
  UUID_RE,
  type OrgoConfig,
  type OrgoErrorCode,
} from "./orgoApi.js";
import {
  parseComputer,
  parseLifecycle,
  parseOperation,
  type RemoteComputer,
  type RemoteOperation,
} from "./wire.js";

/** A computer as the component returns it. */
export const computerValidator = schema.tables.computers.validator;
export type Computer = Infer<typeof computerValidator>;

const CREATE_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 300;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function publicComputer(row: Doc<"computers">): Computer {
  const { _id: _i, _creationTime: _c, ...rest } = row;
  return rest;
}

// ---- Queries: last observed state, no Orgo call ----

/** The last observation of a computer, or null if this userKey does not own it. */
export const get = query({
  args: { computerId: v.string(), userKey: v.optional(v.string()) },
  returns: v.union(v.null(), computerValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", args.computerId.toLowerCase()))
      .unique();
    if (!row || row.userKey !== args.userKey) return null;
    return publicComputer(row);
  },
});

/** Live (not deleted) computers of one userKey, newest first. */
export const list = query({
  args: { userKey: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(computerValidator),
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const rows = await ctx.db
      .query("computers")
      .withIndex("by_userKey_and_deletedAt", (q) =>
        q.eq("userKey", args.userKey).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(limit);
    return rows.map(publicComputer);
  },
});

// ---- Internal state transitions ----

export const owned = internalQuery({
  args: { computerId: v.string(), userKey: v.optional(v.string()) },
  returns: v.union(v.null(), computerValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", args.computerId))
      .unique();
    if (!row || row.userKey !== args.userKey || row.deletedAt !== undefined) return null;
    return publicComputer(row);
  },
});

export const insertCreated = internalMutation({
  args: computerFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", args.computerId))
      .unique();
    if (existing) throw new Error(`Computer ${args.computerId} is already recorded.`);
    await ctx.db.insert("computers", args);
    return null;
  },
});

const remoteValidator = v.object({
  name: v.string(),
  os: v.string(),
  status: v.string(),
  workspaceId: v.string(),
  createdAt: v.optional(v.string()),
});

/**
 * Applies what one Orgo request saw. An observation older than the stored
 * one is dropped, and a computer known to be gone stays gone, so requests
 * that finish out of order cannot roll the row back.
 */
export const observe = internalMutation({
  args: {
    computerId: v.string(),
    observedAt: v.number(),
    remote: v.union(remoteValidator, v.literal("gone")),
  },
  returns: v.union(v.null(), computerValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", args.computerId))
      .unique();
    if (!row) return null;
    if (row.deletedAt !== undefined) return publicComputer(row);
    if (args.remote === "gone") {
      // Gone is final, whatever order the requests finished in.
      const at = Math.max(args.observedAt, row.observedAt);
      await ctx.db.patch("computers", row._id, {
        status: "deleted",
        observedAt: at,
        deletedAt: at,
      });
    } else if (args.observedAt < row.observedAt) {
      return publicComputer(row);
    } else {
      await ctx.db.patch("computers", row._id, {
        name: args.remote.name,
        os: args.remote.os,
        status: args.remote.status,
        workspaceId: args.remote.workspaceId,
        remoteCreatedAt: args.remote.createdAt ?? row.remoteCreatedAt,
        observedAt: args.observedAt,
      });
    }
    const updated = await ctx.db.get("computers", row._id);
    return updated && publicComputer(updated);
  },
});

const OPERATION_RANK = { queued: 0, running: 1, needs_review: 2, succeeded: 3, failed: 3 } as const;

/**
 * Records an operation. A newer operation replaces an older one. Updates to
 * the same operation only move forward (queued → running → needs_review →
 * succeeded | failed), so a slow caller cannot roll a finished one back,
 * and the first caller's startedAt is kept.
 */
export const setOperation = internalMutation({
  args: { computerId: v.string(), operation: operationValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", args.computerId))
      .unique();
    if (!row) return null;
    const current = row.operation;
    let next = args.operation;
    if (current && current.id === next.id) {
      if (OPERATION_RANK[next.status] < OPERATION_RANK[current.status]) return null;
      if (OPERATION_RANK[current.status] === 3 && next.status !== current.status) return null;
      next = { ...next, startedAt: current.startedAt };
    } else if (current && current.startedAt > next.startedAt) {
      return null;
    }
    await ctx.db.patch("computers", row._id, { operation: next });
    return null;
  },
});

// ---- Actions: call Orgo ----

/** Loads the caller's computer, or throws not_found. Runs before any fetch. */
export async function requireOwned(
  ctx: Pick<ActionCtx, "runQuery">,
  computerIdRaw: string,
  userKey: string | undefined,
): Promise<Computer> {
  const computerId = orgoId(computerIdRaw, "computerId");
  const row: Computer | null = await ctx.runQuery(internal.computers.owned, {
    computerId,
    userKey,
  });
  if (!row) {
    throw orgoError(
      "not_found",
      `Computer ${computerId} is not managed by this component for this userKey, or it was deleted.`,
    );
  }
  return row;
}

function remoteFields(c: RemoteComputer) {
  return {
    name: c.name,
    os: c.os,
    status: c.status,
    workspaceId: c.workspaceId,
    createdAt: c.createdAt,
  };
}

export const create = action({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    os: v.optional(v.union(v.literal("linux"), v.literal("windows"))),
    cpu: v.optional(v.number()),
    ram: v.optional(v.number()),
    diskSizeGb: v.optional(v.number()),
    resolution: v.optional(v.string()),
    templateRef: v.optional(v.string()),
    userKey: v.optional(v.string()),
  },
  returns: computerValidator,
  handler: async (ctx, args) => {
    const workspaceId = orgoId(args.workspaceId, "workspaceId");
    const name = args.name.trim();
    if (!name || name.length > 80) {
      throw orgoError("invalid_argument", "name must be 1 to 80 characters.");
    }
    const config = resolveConfig(env);
    const hardware: Record<string, unknown> = {};
    if (args.os !== undefined) hardware.os = args.os;
    if (args.cpu !== undefined) hardware.cpu = args.cpu;
    if (args.ram !== undefined) hardware.ram = args.ram;
    if (args.diskSizeGb !== undefined) hardware.disk_size_gb = args.diskSizeGb;
    if (args.resolution !== undefined) hardware.resolution = args.resolution;
    if (args.templateRef !== undefined) hardware.template_ref = args.templateRef;

    const observedAt = Date.now();
    let body: unknown;
    try {
      body = (
        await orgoJson(config, {
          method: "POST",
          path: "/computers",
          json: { ...hardware, name, workspace_id: workspaceId },
          timeoutMs: CREATE_TIMEOUT_MS,
        })
      ).body;
    } catch (e) {
      if (isOrgoError(e) && outcomeUnknown(e)) {
        // Never retried here: a second POST could create a second computer.
        throw orgoError(
          e.data.code,
          `${e.data.message} Orgo may have created "${name}" anyway; check the workspace before trying again.`,
          { status: e.data.status, orgoCode: e.data.orgoCode },
        );
      }
      throw e;
    }
    // Orgo created it. Keep it trackable even if the rest of the answer is
    // malformed: an id is enough, the request fills in the other fields.
    const computer = createdRow(body, {
      name,
      workspaceId,
      os: args.os ?? "linux",
      userKey: args.userKey,
      observedAt,
    });
    try {
      await ctx.runMutation(internal.computers.insertCreated, computer);
    } catch {
      throw orgoError(
        "server_error",
        `Orgo created computer ${computer.computerId} in workspace ${workspaceId}, but the component could not record it. Do not create it again: check that computer in Orgo first, then use it outside this component or delete it there.`,
      );
    }
    return computer;
  },
});

function createdRow(
  body: unknown,
  sent: { name: string; workspaceId: string; os: string; userKey?: string; observedAt: number },
): Computer {
  try {
    const c = parseComputer(body);
    return {
      computerId: orgoId(c.id, "Orgo's computer id"),
      workspaceId: c.workspaceId,
      name: c.name,
      os: c.os,
      status: c.status,
      userKey: sent.userKey,
      remoteCreatedAt: c.createdAt,
      observedAt: sent.observedAt,
    };
  } catch {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw orgoError(
        "invalid_response",
        `Orgo answered the create without a computer id. It may have created "${sent.name}"; check the workspace before trying again.`,
      );
    }
    return {
      computerId: id.toLowerCase(),
      workspaceId: sent.workspaceId,
      name: sent.name,
      os: sent.os,
      status: "creating",
      userKey: sent.userKey,
      observedAt: sent.observedAt,
    };
  }
}

/** Re-reads one computer from Orgo. Null once Orgo says it no longer exists. */
export async function refreshOwned(
  ctx: Pick<ActionCtx, "runMutation">,
  config: OrgoConfig,
  computerId: string,
): Promise<Computer | null> {
  const observedAt = Date.now();
  try {
    const res = await orgoJson(config, {
      method: "GET",
      path: `/computers/${computerId}`,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const remote = parseComputer(res.body);
    return await ctx.runMutation(internal.computers.observe, {
      computerId,
      observedAt,
      remote: remoteFields(remote),
    });
  } catch (e) {
    // Only a 404 means gone. 401/403/5xx/network say nothing about the computer.
    if (isOrgoError(e) && e.data.status === 404) {
      await ctx.runMutation(internal.computers.observe, { computerId, observedAt, remote: "gone" });
      return null;
    }
    throw e;
  }
}

/**
 * Re-reads a computer from Orgo. If a start or stop was left pending, its
 * operation is read too (no new request to start or stop), so the row
 * shows how it ended.
 */
export const refresh = action({
  args: { computerId: v.string(), userKey: v.optional(v.string()) },
  returns: v.union(v.null(), computerValidator),
  handler: async (ctx, args) => {
    const row = await requireOwned(ctx, args.computerId, args.userKey);
    const config = resolveConfig(env);
    const op = row.operation;
    if (op && OPERATION_RANK[op.status] < 3) {
      try {
        const polled = await orgoJson(config, {
          method: "GET",
          path: `/computers/${row.computerId}/operations/${op.id}`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        const remote = parseOperation(polled.body, config.apiKey);
        await ctx.runMutation(internal.computers.setOperation, {
          computerId: row.computerId,
          operation: operationRecord(remote, op.startedAt),
        });
      } catch (e) {
        // Orgo no longer has the operation; the computer read below still runs.
        if (!(isOrgoError(e) && e.data.status === 404)) throw e;
      }
    }
    return await refreshOwned(ctx, config, row.computerId);
  },
});

/** The row form of an Orgo operation. */
function operationRecord(o: RemoteOperation, startedAt: number) {
  return {
    id: o.id,
    action: o.action,
    status: o.status,
    ...(o.errorCode !== undefined ? { errorCode: o.errorCode } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
    startedAt,
    updatedAt: Date.now(),
  };
}

export const lifecycleResultValidator = v.object({
  computer: v.union(v.null(), computerValidator),
  /** True when Orgo is still working on it: refresh later to see the outcome. */
  pending: v.boolean(),
  operation: v.optional(operationValidator),
});
export type LifecycleResult = Infer<typeof lifecycleResultValidator>;

const lifecycleArgs = {
  computerId: v.string(),
  userKey: v.optional(v.string()),
  /** How long to wait for Orgo to finish (0–300 s, default 120). */
  waitSeconds: v.optional(v.number()),
};

const OP_ERROR_CODES: Record<number, OrgoErrorCode> = {
  400: "bad_request",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  503: "unavailable",
};

async function runLifecycle(
  ctx: ActionCtx,
  action: "start" | "stop",
  args: { computerId: string; userKey?: string; waitSeconds?: number },
): Promise<LifecycleResult> {
  const row = await requireOwned(ctx, args.computerId, args.userKey);
  const waitSeconds = args.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
    throw orgoError("invalid_argument", `waitSeconds must be between 0 and ${MAX_WAIT_SECONDS}.`);
  }
  const config = resolveConfig(env);
  const computerId = row.computerId;
  const startedAt = Date.now();

  // Always async: Orgo's synchronous mode holds the request up to 300 s.
  const res = await orgoJson(config, {
    method: "POST",
    path: `/computers/${computerId}/${action}`,
    json: { async: true },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const answer = parseLifecycle(res.status, res.body, action, config.apiKey);
  if (answer.kind === "done") {
    return { computer: await refreshOwned(ctx, config, computerId), pending: false };
  }

  let op: RemoteOperation = answer.operation;
  const record = async (o: RemoteOperation) => {
    const operation = operationRecord(o, startedAt);
    await ctx.runMutation(internal.computers.setOperation, { computerId, operation });
    return operation;
  };
  let operation = await record(op);
  const pending = async (): Promise<LifecycleResult> => {
    const computer: Computer | null = await ctx.runQuery(internal.computers.owned, {
      computerId,
      userKey: args.userKey,
    });
    return { computer, pending: true, operation };
  };
  if (waitSeconds === 0) return await pending();

  const deadline = startedAt + waitSeconds * 1000;
  for (;;) {
    const polled = await orgoJson(config, {
      method: "GET",
      path: `/computers/${computerId}/operations/${op.id}`,
      // Keep each poll inside the wait the caller asked for (at least 5 s).
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(5_000, deadline - Date.now())),
    });
    const next = parseOperation(polled.body, config.apiKey);
    if (next.status !== op.status) operation = await record(next);
    op = next;
    if (op.status === "succeeded") {
      return { computer: await refreshOwned(ctx, config, computerId), pending: false, operation };
    }
    if (op.status === "failed") {
      const code = (op.errorStatus !== undefined && OP_ERROR_CODES[op.errorStatus]) || "conflict";
      throw orgoError(code, op.error ?? `Orgo could not ${action} the computer.`, {
        status: op.errorStatus,
        orgoCode: op.errorCode,
      });
    }
    if (op.status === "needs_review") {
      throw orgoError(
        "server_error",
        `Orgo could not confirm the ${action}; its operation needs review by Orgo. Refresh the computer later.`,
      );
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) return await pending();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export const start = action({
  args: lifecycleArgs,
  returns: lifecycleResultValidator,
  handler: (ctx, args) => runLifecycle(ctx, "start", args),
});

export const stop = action({
  args: lifecycleArgs,
  returns: lifecycleResultValidator,
  handler: (ctx, args) => runLifecycle(ctx, "stop", args),
});

/**
 * Deletes a computer in Orgo. Refused unless the client was created with
 * `allowDelete: true`. The row stays as a tombstone (status "deleted").
 */
export const remove = action({
  args: {
    computerId: v.string(),
    userKey: v.optional(v.string()),
    allowDelete: v.boolean(),
  },
  returns: v.object({ deleted: v.literal(true) }),
  handler: async (ctx, args) => {
    if (!args.allowDelete) {
      throw orgoError(
        "delete_not_allowed",
        "deleteComputer is off. Create the client with new Orgo(components.orgo, { allowDelete: true }) to allow it.",
      );
    }
    const row = await requireOwned(ctx, args.computerId, args.userKey);
    const config = resolveConfig(env);
    const observedAt = Date.now();
    try {
      await orgoJson(config, {
        method: "DELETE",
        path: `/computers/${row.computerId}`,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (e) {
      if (!(isOrgoError(e) && e.data.status === 404)) throw e;
    }
    await ctx.runMutation(internal.computers.observe, {
      computerId: row.computerId,
      observedAt,
      remote: "gone",
    });
    return { deleted: true as const };
  },
});
