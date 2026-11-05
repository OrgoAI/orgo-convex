import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { DAILY_LIMIT } from "./demo.js";
import { initConvexTest } from "./setup.test.js";
import * as fx from "../../src/fixtures/orgo.js";
import { fakeOrgo, json, resetOrgo, useOrgoEnv } from "../../src/fixtures/fakeOrgo.js";

beforeEach(() => useOrgoEnv());
afterEach(() => resetOrgo());

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code;
  }
  return "no error";
}

async function withDemo() {
  const t = initConvexTest();
  fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
  await t.action(internal.demo.setup, { workspaceId: fx.WORKSPACE_ID });
  return t;
}

describe("public demo", () => {
  test("without setup, actions say not_configured and nothing reaches Orgo", async () => {
    const t = initConvexTest();
    const { calls } = fakeOrgo({});
    expect(await code(t.action(api.demo.runPreset, { preset: "system" }))).toBe("not_configured");
    expect(await t.query(api.demo.state, {})).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("runs only the fixed preset's code", async () => {
    const t = await withDemo();
    const { calls } = fakeOrgo({
      [`POST /computers/${fx.COMPUTER_ID}/bash`]: () => json(fx.bashLinuxOk),
    });
    await t.action(api.demo.runPreset, { preset: "system" });
    expect(calls[0].body).toEqual({ command: "uname -srm && uptime -p", timeout: 30 });
  });

  test("an unknown preset is rejected by the validator", async () => {
    const t = await withDemo();
    const { calls } = fakeOrgo({});
    await expect(
      t.action(api.demo.runPreset, { preset: "rm -rf /" as "system" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("a second action within three seconds is refused as busy", async () => {
    const t = await withDemo();
    const { calls } = fakeOrgo({
      [`POST /computers/${fx.COMPUTER_ID}/bash`]: () => json(fx.bashLinuxOk),
    });
    await t.action(api.demo.runPreset, { preset: "system" });
    expect(await code(t.action(api.demo.runPreset, { preset: "disk" }))).toBe("busy");
    expect(calls).toHaveLength(1);
  });

  test("paused by the operator: refused with no request to Orgo, until resumed", async () => {
    const t = await withDemo();
    await t.mutation(internal.demo.pause, {});
    const { calls } = fakeOrgo({
      [`POST /computers/${fx.COMPUTER_ID}/bash`]: () => json(fx.bashLinuxOk),
    });
    expect(await code(t.action(api.demo.runPreset, { preset: "system" }))).toBe("paused");
    expect(await code(t.action(api.demo.takeScreenshot, {}))).toBe("paused");
    expect(calls).toHaveLength(0);
    await t.mutation(internal.demo.resume, {});
    await t.action(api.demo.runPreset, { preset: "system" });
    expect(calls).toHaveLength(1);
  });

  test("today's allowance used up: refused with no request to Orgo; a new day starts fresh", async () => {
    const t = await withDemo();
    const today = new Date().toISOString().slice(0, 10);
    await t.run(async (ctx) => {
      await ctx.db.insert("throttle", {
        lastAt: Date.now() - 60_000,
        day: today,
        count: DAILY_LIMIT,
      });
    });
    const { calls } = fakeOrgo({
      [`POST /computers/${fx.COMPUTER_ID}/bash`]: () => json(fx.bashLinuxOk),
    });
    expect(await code(t.action(api.demo.runPreset, { preset: "system" }))).toBe("daily_limit");
    expect(calls).toHaveLength(0);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("throttle").first();
      await ctx.db.patch("throttle", row!._id, { day: "2000-01-01" });
    });
    await t.action(api.demo.runPreset, { preset: "system" });
    expect(calls).toHaveLength(1);
  });

  test("each accepted action counts toward the day's allowance", async () => {
    const t = await withDemo();
    const today = new Date().toISOString().slice(0, 10);
    await t.run(async (ctx) => {
      await ctx.db.insert("throttle", {
        lastAt: Date.now() - 60_000,
        day: today,
        count: DAILY_LIMIT - 1,
      });
    });
    const { calls } = fakeOrgo({
      [`POST /computers/${fx.COMPUTER_ID}/bash`]: () => json(fx.bashLinuxOk),
    });
    await t.action(api.demo.runPreset, { preset: "system" }); // the last one allowed today
    await t.run(async (ctx) => {
      const row = await ctx.db.query("throttle").first();
      expect(row?.count).toBe(DAILY_LIMIT);
      await ctx.db.patch("throttle", row!._id, { lastAt: Date.now() - 60_000 }); // past the spacing
    });
    expect(await code(t.action(api.demo.runPreset, { preset: "disk" }))).toBe("daily_limit");
    expect(calls).toHaveLength(1);
  });

  test("setup is idempotent and the page sees the computer and its runs", async () => {
    const t = await withDemo();
    const { calls } = fakeOrgo({});
    expect(await t.action(internal.demo.setup, { workspaceId: fx.WORKSPACE_ID })).toEqual({
      computerId: fx.COMPUTER_ID,
      created: false,
    });
    expect(calls).toHaveLength(0);
    const state = await t.query(api.demo.state, {});
    expect(state).toMatchObject({
      configured: true,
      computer: { status: "running", os: "linux" },
      executions: [],
    });
    // The public page gets what it shows: no ids, workspace or owner key.
    const text = JSON.stringify(state);
    for (const hidden of [fx.COMPUTER_ID, fx.WORKSPACE_ID, "orgo-convex-demo"]) {
      expect(text).not.toContain(hidden);
    }
  });
});
