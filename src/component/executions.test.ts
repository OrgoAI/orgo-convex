import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import * as fx from "../fixtures/orgo.js";
import { fakeOrgo, json, resetOrgo, useOrgoEnv } from "../fixtures/fakeOrgo.js";
import { outcomeOf } from "./executions.js";
import { parseGuestResult } from "./wire.js";

const ID = fx.COMPUTER_ID;

beforeEach(() => useOrgoEnv());
afterEach(() => resetOrgo());

async function errorData(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: { code?: string } }).data;
    if (data?.code) return data as { code: string; message: string; status?: number };
    throw e;
  }
  throw new Error("expected an error");
}

async function setup(userKey = "u") {
  const t = initConvexTest();
  fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
  await t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "n", userKey });
  return t;
}

function runArgs(
  over: Partial<{
    kind: "command" | "python";
    input: string;
    timeoutSeconds: number;
    userKey: string;
    retainOutput: boolean;
  }> = {},
) {
  return {
    computerId: ID,
    userKey: "u",
    kind: "command" as const,
    input: "echo hello",
    retainOutput: false,
    ...over,
  };
}

async function executionRows(t: ReturnType<typeof initConvexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("executions").collect());
}

describe("runCommand", () => {
  test("posts command + timeout, returns output, stores metadata only by default", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json(fx.bashLinuxOk) });
    const res = await t.action(api.executions.run, runArgs());
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ command: "echo hello", timeout: 60 });
    expect(res).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      output: "hello",
      outputTruncated: false,
    });
    const [row] = await executionRows(t);
    expect(row).toMatchObject({
      computerId: ID,
      userKey: "u",
      kind: "command",
      status: "succeeded",
      exitCode: 0,
      timeoutSeconds: 60,
    });
    expect(row.input).toBeUndefined();
    expect(row.output).toBeUndefined();
    expect(row.finishedAt).toBeGreaterThanOrEqual(row.startedAt);
    expect(res.executionId).toBe(row._id);
  });

  test("retention is measured in UTF-8 bytes, cut on a character boundary", async () => {
    const t = await setup();
    fakeOrgo({
      [`POST /computers/${ID}/bash`]: () =>
        json({ ...fx.bashLinuxOk, output: "界".repeat(65_536) }),
    });
    await t.action(
      api.executions.run,
      runArgs({ input: `echo ${"é".repeat(5_000)}`, retainOutput: true }),
    );
    const [row] = await executionRows(t);
    const bytes = (s?: string) => new TextEncoder().encode(s ?? "").length;
    expect(bytes(row.output)).toBeLessThanOrEqual(65_536);
    expect(bytes(row.output)).toBeGreaterThan(65_530);
    expect(row.output).toMatch(/^界+$/);
    expect(bytes(row.input)).toBeLessThanOrEqual(4_096);
    expect(row.input).toMatch(/^echo é+$/);
    expect(row.outputTruncated).toBe(true);
  });

  test("retainOutput stores the command and output, truncated", async () => {
    const t = await setup();
    const long = "y".repeat(70_000);
    fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json({ ...fx.bashLinuxOk, output: long }) });
    const res = await t.action(
      api.executions.run,
      runArgs({ input: `echo ${"x".repeat(5000)}`, retainOutput: true }),
    );
    expect(res.output).toHaveLength(70_000);
    const [row] = await executionRows(t);
    expect(row.input).toHaveLength(4096);
    expect(row.output).toHaveLength(65_536);
    expect(row.outputTruncated).toBe(true);
  });

  test("nonzero exit is failed with its code, not a thrown error", async () => {
    const t = await setup();
    fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json(fx.bashLinuxExit3) });
    expect(await t.action(api.executions.run, runArgs({ input: "exit 3" }))).toMatchObject({
      status: "failed",
      exitCode: 3,
    });
  });

  test("Linux -1 after the full timeout is timed_out; -1 any sooner is failed", async () => {
    const t = await setup();
    const late = async () => {
      await new Promise((r) => setTimeout(r, 1_050));
      return json(fx.bashLinuxKilled);
    };
    fakeOrgo({ [`POST /computers/${ID}/bash`]: [late, () => json(fx.bashLinuxKilled)] });
    expect(
      (await t.action(api.executions.run, runArgs({ input: "sleep 30", timeoutSeconds: 1 })))
        .status,
    ).toBe("timed_out");
    expect(
      (await t.action(api.executions.run, runArgs({ input: "kill -9 $$", timeoutSeconds: 1 })))
        .status,
    ).toBe("failed");
  });

  test("Windows timeout flag is timed_out", async () => {
    const t = await setup();
    fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json(fx.bashWindowsTimeout) });
    expect(await t.action(api.executions.run, runArgs())).toMatchObject({
      status: "timed_out",
      exitCode: 124,
      output: "partial",
    });
  });

  test("an Orgo refusal (4xx) records error and throws", async () => {
    const t = await setup();
    fakeOrgo({
      [`POST /computers/${ID}/bash`]: () => json({ error: "Desktop instance not available" }, 400),
    });
    const err = await errorData(t.action(api.executions.run, runArgs()));
    expect(err.code).toBe("bad_request");
    const [row] = await executionRows(t);
    expect(row).toMatchObject({ status: "error", error: "Desktop instance not available" });
  });

  test.each([
    ["502", () => json({ error: "Bad gateway" }, 502), "unavailable"],
    ["network", () => Promise.reject(new TypeError("fetch failed")), "network"],
    ["invalid JSON", () => new Response("<html>", { status: 200 }), "invalid_response"],
  ])("a lost response (%s) is unknown, thrown, and not retried", async (_, answer, code) => {
    const t = await setup();
    const { calls } = fakeOrgo({ [`POST /computers/${ID}/bash`]: answer as () => Response });
    expect((await errorData(t.action(api.executions.run, runArgs()))).code).toBe(code);
    expect(calls).toHaveLength(1);
    expect((await executionRows(t))[0].status).toBe("unknown");
  });

  test("output over Convex's return limit is cut and flagged", async () => {
    const t = await setup();
    fakeOrgo({
      [`POST /computers/${ID}/bash`]: () =>
        json({ ...fx.bashLinuxOk, output: "z".repeat(4_100_000) }),
    });
    const res = await t.action(api.executions.run, runArgs());
    expect(res.output).toHaveLength(4_000_000);
    expect(res.outputTruncated).toBe(true);
  });

  test.each([
    [{ timeoutSeconds: 0 }],
    [{ timeoutSeconds: 301 }],
    [{ timeoutSeconds: 1.5 }],
    [{ input: "   " }],
    [{ input: "x".repeat(100_001) }],
  ])("invalid %o is refused before any fetch or row", async (over) => {
    const t = await setup();
    const { calls } = fakeOrgo({});
    expect((await errorData(t.action(api.executions.run, runArgs(over)))).code).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(0);
    expect(await executionRows(t)).toHaveLength(0);
  });
});

describe("runPython", () => {
  test("posts code + timeout; Linux success without an exit code", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({ [`POST /computers/${ID}/exec`]: () => json(fx.execLinuxOk) });
    const res = await t.action(
      api.executions.run,
      runArgs({ kind: "python", input: "print(6*7)" }),
    );
    expect(calls[0].body).toEqual({ code: "print(6*7)", timeout: 60 });
    expect(res).toMatchObject({ status: "succeeded", output: "42" });
    expect(res.exitCode).toBeUndefined();
    expect((await executionRows(t))[0].kind).toBe("python");
  });

  test("an exception is failed, with the traceback in output", async () => {
    const t = await setup();
    fakeOrgo({ [`POST /computers/${ID}/exec`]: () => json(fx.execLinuxRaised) });
    const res = await t.action(
      api.executions.run,
      runArgs({ kind: "python", input: "raise ValueError('boom')" }),
    );
    expect(res.status).toBe("failed");
    expect(res.output).toContain("ValueError: boom");
  });

  test("success:false after the full timeout is timed_out; an immediate exception is failed", async () => {
    const t = await setup();
    const late = async () => {
      await new Promise((r) => setTimeout(r, 1_050));
      return json({ ...fx.execLinuxOk, success: false, output: "" });
    };
    fakeOrgo({ [`POST /computers/${ID}/exec`]: [late, () => json(fx.execLinuxRaised)] });
    expect(
      (
        await t.action(
          api.executions.run,
          runArgs({ kind: "python", input: "while True: pass", timeoutSeconds: 1 }),
        )
      ).status,
    ).toBe("timed_out");
    expect(
      (
        await t.action(
          api.executions.run,
          runArgs({ kind: "python", input: "raise ValueError()", timeoutSeconds: 1 }),
        )
      ).status,
    ).toBe("failed");
  });

  test("a command answered with success but no exit code is unknown, not succeeded", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({
      [`POST /computers/${ID}/bash`]: () => json({ success: true, output: "x" }),
    });
    const err = await errorData(t.action(api.executions.run, runArgs()));
    expect(err.code).toBe("invalid_response");
    expect(calls).toHaveLength(1);
    expect((await executionRows(t))[0].status).toBe("unknown");
  });

  test("a 200 that does not say how the run ended is unknown, thrown, not retried", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({ [`POST /computers/${ID}/exec`]: () => json({}) });
    const err = await errorData(
      t.action(api.executions.run, runArgs({ kind: "python", input: "print(1)" })),
    );
    expect(err.code).toBe("invalid_response");
    expect(calls).toHaveLength(1);
    expect((await executionRows(t))[0].status).toBe("unknown");
  });
});

describe("outcomeOf", () => {
  test.each([
    [{ output: "", exitCode: 0, timedOut: false }, 10, 60, "succeeded"],
    [{ output: "", exitCode: 2, timedOut: false }, 59_000, 60, "failed"],
    [{ output: "", exitCode: -1, timedOut: false }, 60_000, 60, "timed_out"],
    [{ output: "", exitCode: -1, timedOut: false }, 59_999, 60, "failed"],
    [{ output: "", exitCode: -1, timedOut: false }, 10, 1, "failed"],
    [{ output: "", success: false, timedOut: false }, 10, 1, "failed"],
    [{ output: "", exitCode: 124, timedOut: true }, 10, 60, "timed_out"],
    [{ output: "", success: true, timedOut: false }, 10, 60, "succeeded"],
    [{ output: "", success: false, timedOut: false }, 10, 60, "failed"],
    [{ output: "", success: false, timedOut: false }, 60_000, 60, "timed_out"],
    [{ output: "", timedOut: false }, 10, 60, "failed"],
  ] as const)("%o after %i ms (timeout %i s) → %s", (result, ms, timeout, expected) => {
    expect(outcomeOf(result, ms, timeout)).toBe(expected);
  });
});

describe("ownership and history", () => {
  test("another userKey cannot run, read or list, and nothing reaches Orgo", async () => {
    const t = await setup("user_a");
    fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json(fx.bashLinuxOk) });
    const { executionId } = await t.action(api.executions.run, runArgs({ userKey: "user_a" }));
    const { calls } = fakeOrgo({});
    expect(
      (await errorData(t.action(api.executions.run, runArgs({ userKey: "user_b" })))).code,
    ).toBe("not_found");
    expect(await t.query(api.executions.get, { executionId, userKey: "user_b" })).toBeNull();
    expect(await t.query(api.executions.get, { executionId })).toBeNull();
    expect(await t.query(api.executions.list, { computerId: ID, userKey: "user_b" })).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await executionRows(t)).toHaveLength(1);
    expect(await t.query(api.executions.get, { executionId, userKey: "user_a" })).toMatchObject({
      status: "succeeded",
    });
    expect(await t.query(api.executions.list, { computerId: ID, userKey: "user_a" })).toHaveLength(
      1,
    );
  });

  test("a malformed execution id is null, not an error", async () => {
    const t = await setup();
    expect(await t.query(api.executions.get, { executionId: "nope", userKey: "u" })).toBeNull();
  });

  test("list is newest first and bounded", async () => {
    const t = await setup();
    fakeOrgo({ [`POST /computers/${ID}/bash`]: () => json(fx.bashLinuxOk) });
    for (let i = 0; i < 3; i++) await t.action(api.executions.run, runArgs({ input: `echo ${i}` }));
    const rows = await t.query(api.executions.list, { computerId: ID, userKey: "u", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].startedAt).toBeGreaterThanOrEqual(rows[1].startedAt);
  });

  async function seed(
    t: ReturnType<typeof initConvexTest>,
    rows: Array<{ age: number; status?: "running" | "succeeded"; userKey?: string }>,
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const r of rows) {
        await ctx.db.insert("executions", {
          computerId: ID,
          userKey: r.userKey,
          kind: "command",
          status: r.status ?? "succeeded",
          timeoutSeconds: 60,
          startedAt: now - r.age,
        });
      }
    });
  }

  test("purge deletes only rows that started before the cutoff, whatever order they were written in", async () => {
    const t = await setup();
    await seed(t, [{ age: 0 }, { age: 10_000 }, { age: 1_000 }, { age: 5_000 }]); // inserted out of order
    expect(await t.mutation(api.executions.purge, { olderThanMs: 4_000 })).toEqual({
      deleted: 2,
      hasMore: false,
    });
    expect((await executionRows(t)).map((r) => Date.now() - r.startedAt < 4_000)).toEqual([
      true,
      true,
    ]);
  });

  test("purge keeps runs in progress, but clears ones abandoned for 15 minutes", async () => {
    const t = await setup();
    await seed(t, [
      { age: 60_000, status: "running" },
      { age: 16 * 60_000, status: "running" },
      { age: 60_000 },
    ]);
    expect(await t.mutation(api.executions.purge, { olderThanMs: 0 })).toEqual({
      deleted: 2,
      hasMore: false,
    });
    const [left] = await executionRows(t);
    expect(left.status).toBe("running");
  });

  test("many runs in progress never hide finished rows from purge", async () => {
    const t = await setup();
    await seed(t, [
      ...Array.from({ length: 210 }, () => ({ age: 60_000, status: "running" as const })),
      { age: 30_000 },
    ]);
    expect(await t.mutation(api.executions.purge, { olderThanMs: 0 })).toEqual({
      deleted: 1,
      hasMore: false,
    });
    expect((await executionRows(t)).every((r) => r.status === "running")).toBe(true);
  });

  test("purge is global maintenance: it clears every owner's old rows", async () => {
    const t = await setup();
    await seed(t, [
      { age: 10_000, userKey: "a" },
      { age: 10_000, userKey: "b" },
    ]);
    expect((await t.mutation(api.executions.purge, { olderThanMs: 0 })).deleted).toBe(2);
  });

  test("purge works in bounded batches", async () => {
    const t = await setup();
    await seed(
      t,
      Array.from({ length: 130 }, (_, i) => ({ age: 10_000 + i })),
    );
    expect(await t.mutation(api.executions.purge, { olderThanMs: 0 })).toEqual({
      deleted: 100,
      hasMore: true,
    });
    expect(await t.mutation(api.executions.purge, { olderThanMs: 0 })).toEqual({
      deleted: 30,
      hasMore: false,
    });
  });

  test("a run whose row was purged mid-flight still returns its result", async () => {
    const t = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fakeOrgo({
      [`POST /computers/${ID}/bash`]: async () => {
        await gate;
        return json(fx.bashLinuxOk);
      },
    });
    const pending = t.action(api.executions.run, runArgs());
    await new Promise((r) => setTimeout(r, 50));
    // Simulate a run abandoned long ago: its row is old enough to be cleared.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("executions").collect())
        await ctx.db.delete("executions", row._id);
    });
    release();
    expect(await pending).toMatchObject({ status: "succeeded", output: "hello" });
    expect(await executionRows(t)).toHaveLength(0);
  });
});

describe("responses captured from a real computer", () => {
  test.each([
    ["bashOk", "command", 300, 60, "succeeded", 0, "hello\n"],
    ["bashExit2Stderr", "command", 300, 60, "failed", 2, "out\n\nerr\n"],
    ["bashTimeout2s", "command", 2_100, 2, "timed_out", -1, ""],
    ["execOk", "python", 250, 60, "succeeded", undefined, "42\n"],
    ["execRaise", "python", 250, 60, "failed", undefined, "ValueError: boom"],
    ["execTimeout2s", "python", 2_100, 2, "timed_out", undefined, ""],
  ] as const)("%s → %s", async (name, kind, ms, timeout, status, exitCode, output) => {
    const live = await import("../fixtures/live.js");
    const parsed = parseGuestResult(live[name], kind);
    expect(outcomeOf(parsed, ms, timeout)).toBe(status);
    expect(parsed.exitCode).toBe(exitCode);
    expect(parsed.output).toContain(output);
  });
});
