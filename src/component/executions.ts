// Running shell commands and Python on a computer, one execution row each.
// By default a row holds metadata only (status, exit code, timing): the
// command and its output can carry secrets, so they are stored only when
// the client opts in with `retainOutput`, and then truncated. The action's
// return value always carries the output.
import { v, type Infer } from "convex/values";
import { action, env, internalMutation, mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import schema, { executionStatusValidator } from "./schema.js";
import { requireOwned } from "./computers.js";
import {
  clampLimit,
  isOrgoError,
  orgoError,
  orgoJson,
  outcomeUnknown,
  resolveConfig,
  truncate,
} from "./orgoApi.js";
import { parseGuestResult, type GuestResult } from "./wire.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
/** Orgo clamps a command's timeout to 300 s. */
const MAX_TIMEOUT_SECONDS = 300;
/** Orgo's proxy waits 30 s past the command timeout; leave room past that. */
const FETCH_MARGIN_MS = 45_000;
const MAX_INPUT_CHARS = 100_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETURNED_OUTPUT_CHARS = 4_000_000;
/** UTF-8 bytes kept with retainOutput. A row stays under ~70 KB however wide its characters. */
const RETAINED_INPUT_BYTES = 4_096;
const RETAINED_OUTPUT_BYTES = 65_536;
const DEFAULT_LIST_LIMIT = 50;
/** 100 rows of at most ~70 KB stay well inside Convex's 16 MiB read and return limits. */
const MAX_LIST_LIMIT = 100;
const PURGE_BATCH = 100;
/** No run lasts this long (the fetch deadline is at most 345 s), so a row still "running" is abandoned. */
const ABANDONED_AFTER_MS = 15 * 60_000;

export const executionValidator = schema.tables.executions.validator.extend({
  _id: v.id("executions"),
  _creationTime: v.number(),
});
export type Execution = Infer<typeof executionValidator>;

export const runResultValidator = v.object({
  executionId: v.id("executions"),
  status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("timed_out")),
  /** Absent when Orgo reports none (Python on Linux reports success only). */
  exitCode: v.optional(v.number()),
  /** Combined stdout and stderr as Orgo returns it. */
  output: v.string(),
  /** True when output was cut to fit Convex's return size (4M characters). */
  outputTruncated: v.boolean(),
  durationMs: v.number(),
});
export type RunResult = Infer<typeof runResultValidator>;

export const insertRunning = internalMutation({
  args: {
    computerId: v.string(),
    userKey: v.optional(v.string()),
    kind: v.union(v.literal("command"), v.literal("python")),
    timeoutSeconds: v.number(),
    input: v.optional(v.string()),
    startedAt: v.number(),
  },
  returns: v.id("executions"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("executions", { ...args, status: "running" });
  },
});

export const finish = internalMutation({
  args: {
    executionId: v.id("executions"),
    status: executionStatusValidator,
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    outputTruncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
    finishedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { executionId, ...fields }) => {
    // The row may have been purged meanwhile; the run's result still stands.
    if (await ctx.db.get("executions", executionId)) {
      await ctx.db.patch("executions", executionId, fields);
    }
    return null;
  },
});

/**
 * How a guest's answer reads, given how long the run took. Windows says
 * when it timed out. Linux does not: bash reports -1 and Python reports
 * success:false, the same as a crash. A guest cannot time out before its
 * timeout has passed, and our duration includes the request around it, so
 * only a run that lasted the full timeout is read as timed out.
 */
export function outcomeOf(
  result: GuestResult,
  durationMs: number,
  timeoutSeconds: number,
): "succeeded" | "failed" | "timed_out" {
  const ranFullTimeout = durationMs >= timeoutSeconds * 1000;
  if (result.timedOut) return "timed_out";
  if (result.exitCode !== undefined) {
    if (result.exitCode === 0) return "succeeded";
    return result.exitCode === -1 && ranFullTimeout ? "timed_out" : "failed";
  }
  if (result.success === true) return "succeeded";
  return ranFullTimeout ? "timed_out" : "failed";
}

/** Cuts a string to at most `maxBytes` of UTF-8, on a character boundary. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1; // back to a character start
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

export const run = action({
  args: {
    computerId: v.string(),
    userKey: v.optional(v.string()),
    kind: v.union(v.literal("command"), v.literal("python")),
    /** The shell command (bash on Linux, PowerShell on Windows) or Python code. */
    input: v.string(),
    /** 1 to 300 seconds, default 60. */
    timeoutSeconds: v.optional(v.number()),
    retainOutput: v.boolean(),
  },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    const computer = await requireOwned(ctx, args.computerId, args.userKey);
    const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw orgoError(
        "invalid_argument",
        `timeoutSeconds must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS}.`,
      );
    }
    const what = args.kind === "command" ? "command" : "code";
    if (!args.input.trim()) throw orgoError("invalid_argument", `${what} must not be empty.`);
    if (args.input.length > MAX_INPUT_CHARS) {
      throw orgoError("invalid_argument", `${what} is longer than ${MAX_INPUT_CHARS} characters.`);
    }
    const config = resolveConfig(env);

    const startedAt = Date.now();
    const executionId: Id<"executions"> = await ctx.runMutation(internal.executions.insertRunning, {
      computerId: computer.computerId,
      userKey: args.userKey,
      kind: args.kind,
      timeoutSeconds,
      input: args.retainOutput ? truncateUtf8(args.input, RETAINED_INPUT_BYTES).text : undefined,
      startedAt,
    });

    let result: GuestResult;
    try {
      const res = await orgoJson(config, {
        method: "POST",
        path: `/computers/${computer.computerId}/${args.kind === "command" ? "bash" : "exec"}`,
        json:
          args.kind === "command"
            ? { command: args.input, timeout: timeoutSeconds }
            : { code: args.input, timeout: timeoutSeconds },
        timeoutMs: timeoutSeconds * 1000 + FETCH_MARGIN_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      result = parseGuestResult(res.body, args.kind);
    } catch (e) {
      // Never retried: a second POST could run the command twice.
      const unknown = outcomeUnknown(e) || (isOrgoError(e) && e.data.code === "too_large");
      await ctx.runMutation(internal.executions.finish, {
        executionId,
        status: unknown ? "unknown" : "error",
        error: isOrgoError(e) ? e.data.message : "The request to Orgo failed.",
        finishedAt: Date.now(),
      });
      throw e;
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;
    const status = outcomeOf(result, durationMs, timeoutSeconds);
    const returned = truncate(result.output, MAX_RETURNED_OUTPUT_CHARS);
    const retained = args.retainOutput
      ? truncateUtf8(result.output, RETAINED_OUTPUT_BYTES)
      : undefined;
    await ctx.runMutation(internal.executions.finish, {
      executionId,
      status,
      exitCode: result.exitCode,
      output: retained?.text,
      outputTruncated: retained?.truncated,
      finishedAt,
    });
    return {
      executionId,
      status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      output: returned.text,
      outputTruncated: returned.truncated,
      durationMs,
    };
  },
});

/** One execution, or null if it does not exist or `userKey` does not own it. */
export const get = query({
  args: { executionId: v.string(), userKey: v.optional(v.string()) },
  returns: v.union(v.null(), executionValidator),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("executions", args.executionId);
    const row = id && (await ctx.db.get("executions", id));
    if (!row || row.userKey !== args.userKey) return null;
    return row;
  },
});

/** Executions on one computer, newest first, if `userKey` owns it. */
export const list = query({
  args: { computerId: v.string(), userKey: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(executionValidator),
  handler: async (ctx, args) => {
    const computerId = args.computerId.toLowerCase();
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_computerId", (q) => q.eq("computerId", computerId))
      .unique();
    if (!computer || computer.userKey !== args.userKey) return [];
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const rows: Doc<"executions">[] = await ctx.db
      .query("executions")
      .withIndex("by_computerId_and_startedAt", (q) => q.eq("computerId", computerId))
      .order("desc")
      .take(limit);
    return rows;
  },
});

/**
 * Maintenance for the host's operators, not for end users: deletes every
 * owner's executions that started more than `olderThanMs` ago, at most 100
 * per call (finished runs status by status, then abandoned ones). A run still in progress is kept (unless it has been
 * "running" for 15 minutes, which means its action died). Call again while
 * `hasMore` is true.
 */
export const purge = mutation({
  args: { olderThanMs: v.number() },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    if (!(args.olderThanMs >= 0))
      throw orgoError("invalid_argument", "olderThanMs must be 0 or more.");
    const now = Date.now();
    const cutoff = now - args.olderThanMs;
    // One index range per status, so runs in progress are never read past:
    // finished runs before the cutoff, and "running" ones only once abandoned.
    const ranges: Array<[Doc<"executions">["status"], number]> = [
      ["succeeded", cutoff],
      ["failed", cutoff],
      ["timed_out", cutoff],
      ["error", cutoff],
      ["unknown", cutoff],
      ["running", Math.min(cutoff, now - ABANDONED_AFTER_MS)],
    ];
    let deleted = 0;
    for (const [status, before] of ranges) {
      for await (const row of ctx.db
        .query("executions")
        .withIndex("by_status_and_startedAt", (q) =>
          q.eq("status", status).lt("startedAt", before),
        )) {
        if (deleted === PURGE_BATCH) return { deleted, hasMore: true };
        await ctx.db.delete("executions", row._id);
        deleted += 1;
      }
    }
    return { deleted, hasMore: false };
  },
});
