import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** A start or stop Orgo accepted and has not finished yet, or how it ended. */
export const operationValidator = v.object({
  /** Orgo operation id (poll `GET /api/computers/{id}/operations/{id}`). */
  id: v.string(),
  action: v.union(v.literal("start"), v.literal("stop")),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("needs_review"),
  ),
  /** Orgo's error code and message when the operation failed. */
  errorCode: v.optional(v.string()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  updatedAt: v.number(),
});

/**
 * The component's last observation of an Orgo computer it created. The
 * source of truth is always the Orgo API: `refreshComputer` re-reads it.
 * Only these fields are kept; credentials in Orgo's responses never land here.
 */
export const computerFields = {
  /** Orgo computer id. Not a Convex document id. */
  computerId: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  os: v.string(),
  /**
   * Last status Orgo reported: creating, running, restarting, updating,
   * suspending, suspended, resuming, frozen, stopped, error or deleted.
   * A string, so a status Orgo adds later is stored rather than rejected.
   */
  status: v.string(),
  /**
   * Owner key from the host app (e.g. the signed-in user's id). Every read
   * and action on this computer must present the same key.
   */
  userKey: v.optional(v.string()),
  /** Orgo's created_at (ISO 8601). */
  remoteCreatedAt: v.optional(v.string()),
  /** When `status` was observed (ms): the start of the request that saw it. */
  observedAt: v.number(),
  /** The latest start or stop, kept apart from the observed status. */
  operation: v.optional(operationValidator),
  /** Set once Orgo confirmed the computer is gone. Never cleared. */
  deletedAt: v.optional(v.number()),
};

export const executionStatusValidator = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("timed_out"),
  /** Orgo refused the request (4xx): the command did not run. */
  v.literal("error"),
  /** The response was lost (network, 5xx, deadline): it may or may not have run. */
  v.literal("unknown"),
);

/** One row per runCommand / runPython call. */
export const executionFields = {
  computerId: v.string(),
  userKey: v.optional(v.string()),
  kind: v.union(v.literal("command"), v.literal("python")),
  status: executionStatusValidator,
  timeoutSeconds: v.number(),
  /** Absent when Orgo did not report one (Linux Python reports success only). */
  exitCode: v.optional(v.number()),
  /** Command or code, only with `retainOutput` (first 4 KB of UTF-8). */
  input: v.optional(v.string()),
  /** Combined stdout and stderr, only with `retainOutput` (first 64 KB of UTF-8). */
  output: v.optional(v.string()),
  outputTruncated: v.optional(v.boolean()),
  /** Why the call failed, when it did not reach a result. Never contains output. */
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
};

export default defineSchema({
  computers: defineTable(computerFields)
    .index("by_computerId", ["computerId"])
    .index("by_userKey_and_deletedAt", ["userKey", "deletedAt"]),
  executions: defineTable(executionFields)
    .index("by_computerId_and_startedAt", ["computerId", "startedAt"])
    .index("by_status_and_startedAt", ["status", "startedAt"]),
});
