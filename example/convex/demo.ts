// The public demo. Anyone with the link can drive ONE computer that the
// operator created (`npx convex run demo:setup`), with fixed commands only:
// no free-form input, no create, stop or delete from the browser. Across all
// visitors: one action every three seconds, at most DAILY_LIMIT a day (UTC),
// none while the operator has paused it (demo:pause), and run history older
// than a day is cleared every hour (crons.ts).
import { ConvexError, v } from "convex/values";
import { Orgo, orgoErrorData, type RunResult } from "orgo-convex";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server.js";

/** The demo computer's owner key. Fixed on the server, never taken from a visitor. */
const DEMO_USER = "orgo-convex-demo";
const SPACING_MS = 3_000;
export const DAILY_LIMIT = 300;
const HISTORY_MS = 24 * 3600_000;

const orgo = new Orgo(components.orgo);
const orgoAdmin = new Orgo(components.orgo, { allowDelete: true });

export const PRESETS = {
  system: { label: "Which system is this?", kind: "command", code: "uname -srm && uptime -p" },
  disk: { label: "How full is the disk?", kind: "command", code: "df -h / | tail -1" },
  python: {
    label: "Run Python",
    kind: "python",
    code: "import platform\nprint(f'Python {platform.python_version()} on {platform.system()}')",
  },
  primes: {
    label: "Compute in Python",
    kind: "python",
    code: "print([n for n in range(2, 60) if all(n % d for d in range(2, n))])",
  },
  timeout: {
    label: "Hit a 3-second timeout",
    kind: "command",
    code: "sleep 8 && echo finished",
    timeoutSeconds: 3,
  },
} as const;
type PresetName = keyof typeof PRESETS;
const presetName = v.union(...(Object.keys(PRESETS) as PresetName[]).map((k) => v.literal(k)));

export const presets = query({
  args: {},
  handler: async () =>
    (Object.keys(PRESETS) as PresetName[]).map((name) => {
      const { label, kind, code } = PRESETS[name];
      return { name, label, kind, code };
    }),
});

export const demoRow = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("demo").first(),
});

/**
 * Everything the page shows, and nothing more (no ids or owner key).
 * Reactive: the component's tables push updates.
 */
export const state = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("demo").first();
    if (!row) return { configured: false as const };
    const owned = { computerId: row.computerId, userKey: DEMO_USER };
    const computer = await orgo.getComputer(ctx, owned);
    const executions = await orgo.listExecutions(ctx, { ...owned, limit: 8 });
    const shot = await ctx.db.query("screenshots").order("desc").first();
    return {
      configured: true as const,
      computer: computer && {
        status: computer.status,
        os: computer.os,
        observedAt: computer.observedAt,
      },
      executions: executions.map((x) => ({
        id: x._id,
        kind: x.kind,
        status: x.status,
        exitCode: x.exitCode,
        startedAt: x.startedAt,
        finishedAt: x.finishedAt,
      })),
      screenshot: shot && {
        url: await ctx.storage.getUrl(shot.storageId),
        width: shot.width,
        height: shot.height,
        takenAt: shot.takenAt,
      },
    };
  },
});

/** Takes one turn, or refuses: paused, too soon after the last one, or over today's allowance. */
export const claimTurn = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ computerId: string }> => {
    const demo = await ctx.db.query("demo").first();
    if (!demo) throw new ConvexError({ code: "not_configured" });
    if (demo.paused) throw new ConvexError({ code: "paused" });
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const row = await ctx.db.query("throttle").first();
    if (row && now - row.lastAt < SPACING_MS) {
      throw new ConvexError({ code: "busy", retryInMs: SPACING_MS - (now - row.lastAt) });
    }
    const count = row && row.day === day ? (row.count ?? 0) : 0;
    if (count >= DAILY_LIMIT) throw new ConvexError({ code: "daily_limit", limit: DAILY_LIMIT });
    if (row) await ctx.db.patch("throttle", row._id, { lastAt: now, day, count: count + 1 });
    else await ctx.db.insert("throttle", { lastAt: now, day, count: 1 });
    return { computerId: demo.computerId };
  },
});

async function demoComputer(ctx: ActionCtx): Promise<{ computerId: string; userKey: string }> {
  const { computerId } = await ctx.runMutation(internal.demo.claimTurn, {});
  return { computerId, userKey: DEMO_USER };
}

/** Surfaces Orgo errors as plain data the page can show. */
function rethrow(e: unknown): never {
  const data = orgoErrorData(e);
  if (data) throw new ConvexError({ code: data.code, message: data.message });
  throw e;
}

export const runPreset = action({
  args: { preset: presetName },
  handler: async (ctx, args): Promise<RunResult> => {
    const owned = await demoComputer(ctx);
    const p = PRESETS[args.preset];
    const timeoutSeconds = "timeoutSeconds" in p ? p.timeoutSeconds : 30;
    try {
      return p.kind === "command"
        ? await orgo.runCommand(ctx, { ...owned, command: p.code, timeoutSeconds })
        : await orgo.runPython(ctx, { ...owned, code: p.code, timeoutSeconds });
    } catch (e) {
      rethrow(e);
    }
  },
});

export const saveScreenshot = internalMutation({
  args: { storageId: v.id("_storage"), width: v.number(), height: v.number() },
  handler: async (ctx, args) => {
    for (const old of await ctx.db.query("screenshots").take(10)) {
      await ctx.storage.delete(old.storageId);
      await ctx.db.delete("screenshots", old._id);
    }
    await ctx.db.insert("screenshots", { ...args, takenAt: Date.now() });
  },
});

export const takeScreenshot = action({
  args: {},
  handler: async (ctx) => {
    const owned = await demoComputer(ctx);
    try {
      const shot = await orgo.screenshot(ctx, owned);
      const storageId = await ctx.storage.store(new Blob([shot.bytes], { type: shot.mimeType }));
      await ctx.runMutation(internal.demo.saveScreenshot, {
        storageId,
        width: shot.width,
        height: shot.height,
      });
    } catch (e) {
      rethrow(e);
    }
  },
});

export const fileRoundTrip = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ path: string; placedIn: string; written: string; readBack: string }> => {
    const owned = await demoComputer(ctx);
    const path = "/tmp/orgo-convex-demo/note.txt";
    const written = `Written by a Convex action at ${new Date().toISOString()}`;
    try {
      const placed = await orgo.uploadFile(ctx, { ...owned, path, content: written });
      const file = await orgo.exportFile(ctx, { ...owned, path });
      return {
        path,
        placedIn: placed.placedIn,
        written,
        readBack: new TextDecoder().decode(file.bytes),
      };
    } catch (e) {
      rethrow(e);
    }
  },
});

export const refresh = action({
  args: {},
  handler: async (ctx) => {
    const owned = await demoComputer(ctx);
    try {
      await orgo.refreshComputer(ctx, owned);
    } catch (e) {
      rethrow(e);
    }
  },
});

// ---- Operator only (npx convex run) ----

/** Creates the demo computer once. Run: npx convex run demo:setup '{"workspaceId":"..."}' */
export const setup = internalAction({
  args: { workspaceId: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ computerId: string; created: boolean }> => {
    const existing: Doc<"demo"> | null = await ctx.runQuery(internal.demo.demoRow, {});
    if (existing) return { computerId: existing.computerId, created: false };
    const computer = await orgo.createComputer(ctx, {
      workspaceId: args.workspaceId,
      name: args.name ?? "orgo-convex-demo",
      userKey: DEMO_USER,
    });
    await ctx.runMutation(internal.demo.saveDemo, { computerId: computer.computerId });
    return { computerId: computer.computerId, created: true };
  },
});

export const saveDemo = internalMutation({
  args: { computerId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("demo", { computerId: args.computerId, setupAt: Date.now() });
  },
});

/** Refuses every public action until demo:resume. Run: npx convex run demo:pause */
export const pause = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("demo").first();
    if (row) await ctx.db.patch("demo", row._id, { paused: true });
  },
});

export const resume = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("demo").first();
    if (row) await ctx.db.patch("demo", row._id, { paused: false });
  },
});

/** Hourly (crons.ts): run history older than a day goes. */
export const purgeHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { hasMore } = await orgo.purgeExecutions(ctx, { olderThanMs: HISTORY_MS });
    if (hasMore) await ctx.scheduler.runAfter(0, internal.demo.purgeHistory, {});
  },
});

export const clearDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const row of await ctx.db.query("demo").take(10)) await ctx.db.delete("demo", row._id);
  },
});

/** Deletes the demo computer in Orgo. Run: npx convex run demo:teardown */
export const teardown = internalAction({
  args: {},
  handler: async (ctx): Promise<{ deleted: boolean }> => {
    const row: Doc<"demo"> | null = await ctx.runQuery(internal.demo.demoRow, {});
    if (!row) return { deleted: false };
    await orgoAdmin.deleteComputer(ctx, { computerId: row.computerId, userKey: DEMO_USER });
    await ctx.runMutation(internal.demo.clearDemo, {});
    return { deleted: true };
  },
});
