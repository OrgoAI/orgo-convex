import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import * as fx from "../fixtures/orgo.js";
import { fakeOrgo, json, resetOrgo, useOrgoEnv } from "../fixtures/fakeOrgo.js";

const ID = fx.COMPUTER_ID;
const OP = fx.OPERATION_ID;

beforeEach(() => useOrgoEnv());
afterEach(() => resetOrgo());

async function errorData(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: { code?: string } }).data;
    if (data?.code)
      return data as { code: string; status?: number; orgoCode?: string; message: string };
    throw e;
  }
  throw new Error("expected an error");
}

/** Creates a computer for `userKey` through the component, Orgo answering 201. */
async function created(t: ReturnType<typeof initConvexTest>, userKey?: string) {
  const { calls } = fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
  const c = await t.action(api.computers.create, {
    workspaceId: fx.WORKSPACE_ID,
    name: "convex-test",
    userKey,
  });
  return { computer: c, calls };
}

async function allRows(t: ReturnType<typeof initConvexTest>) {
  return await t.run(async (ctx) => ({
    computers: await ctx.db.query("computers").collect(),
    executions: await ctx.db.query("executions").collect(),
  }));
}

describe("createComputer", () => {
  test("posts name + workspace_id, stores and returns allow-listed fields only", async () => {
    const t = initConvexTest();
    const { computer, calls } = await created(t, "user_a");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/computers",
      body: { name: "convex-test", workspace_id: fx.WORKSPACE_ID },
    });
    expect(calls[0].headers.authorization).toBe(`Bearer ${fx.SECRET.apiKey}`);
    expect(computer).toMatchObject({
      computerId: ID,
      workspaceId: fx.WORKSPACE_ID,
      name: "convex-test",
      os: "linux",
      status: "running",
      userKey: "user_a",
      remoteCreatedAt: "2026-10-20T23:00:00.000Z",
    });
    const rows = JSON.stringify(await allRows(t));
    for (const s of fx.SENTINELS) {
      expect(JSON.stringify(computer)).not.toContain(s);
      expect(rows).not.toContain(s);
    }
  });

  test("optional hardware fields use Orgo's names", async () => {
    const t = initConvexTest();
    const { calls } = fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
    await t.action(api.computers.create, {
      workspaceId: fx.WORKSPACE_ID,
      name: "x",
      os: "linux",
      cpu: 2,
      ram: 8,
      diskSizeGb: 20,
      resolution: "1280x720x24",
      templateRef: "starter/linux",
    });
    expect(calls[0].body).toEqual({
      name: "x",
      workspace_id: fx.WORKSPACE_ID,
      os: "linux",
      cpu: 2,
      ram: 8,
      disk_size_gb: 20,
      resolution: "1280x720x24",
      template_ref: "starter/linux",
    });
  });

  test("bad workspace id or name is refused before any fetch", async () => {
    const t = initConvexTest();
    const { calls } = fakeOrgo({});
    expect(
      (await errorData(t.action(api.computers.create, { workspaceId: "../x", name: "a" }))).code,
    ).toBe("invalid_argument");
    expect(
      (await errorData(t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: " " })))
        .code,
    ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  test("a lost create response is not retried and says the computer may exist", async () => {
    const t = initConvexTest();
    const { calls } = fakeOrgo({ "POST /computers": () => json({ error: "Bad gateway" }, 502) });
    const err = await errorData(
      t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "convex-test" }),
    );
    expect(err.code).toBe("unavailable");
    expect(err.message).toContain("may have created");
    expect(calls).toHaveLength(1);
    expect((await allRows(t)).computers).toHaveLength(0);
  });

  test("a 201 with an id but missing fields still records the computer", async () => {
    const t = initConvexTest();
    fakeOrgo({
      "POST /computers": () =>
        json({ id: ID.toUpperCase(), vnc_password: fx.SECRET.vncPassword }, 201),
    });
    const c = await t.action(api.computers.create, {
      workspaceId: fx.WORKSPACE_ID,
      name: "partial",
      userKey: "u",
    });
    expect(c).toMatchObject({
      computerId: ID,
      name: "partial",
      workspaceId: fx.WORKSPACE_ID,
      os: "linux",
      status: "creating",
    });
    expect(await t.query(api.computers.get, { computerId: ID, userKey: "u" })).not.toBeNull();
    expect(JSON.stringify(c)).not.toContain(fx.SECRET.vncPassword);
  });

  test.each([
    ["no id", () => json({ name: "x" }, 201)],
    ["not JSON", () => new Response("<html>", { status: 201 })],
  ])("a 201 with %s says the computer may exist and records nothing", async (_, answer) => {
    const t = initConvexTest();
    fakeOrgo({ "POST /computers": answer });
    const err = await errorData(
      t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "convex-test" }),
    );
    expect(err.code).toBe("invalid_response");
    expect(err.message).toContain("may have created");
    expect((await allRows(t)).computers).toHaveLength(0);
  });

  test("if recording fails after Orgo created it, the error names it and says not to create again", async () => {
    const t = initConvexTest();
    await created(t, "u");
    // Orgo answers a second create with the same id: recording it fails.
    const { calls } = fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
    const err = await errorData(
      t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "again", userKey: "u" }),
    );
    expect(err.code).toBe("server_error");
    expect(err.message).toContain(ID);
    expect(err.message).toContain(fx.WORKSPACE_ID);
    expect(err.message).toContain("Do not create it again");
    expect(err.message).not.toMatch(/try again/i);
    expect(calls).toHaveLength(1);
  });

  test("a missing ORGO_API_KEY is a config error before any fetch", async () => {
    const t = initConvexTest();
    resetOrgo();
    const { calls } = fakeOrgo({});
    const err = await errorData(
      t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "a" }),
    );
    expect(err.code).toBe("config");
    expect(calls).toHaveLength(0);
  });
});

describe("ownership", () => {
  test("user B cannot read or act on user A's computer, and no request reaches Orgo", async () => {
    const t = initConvexTest();
    await created(t, "user_a");
    const { calls } = fakeOrgo({});
    expect(await t.query(api.computers.get, { computerId: ID, userKey: "user_b" })).toBeNull();
    expect(await t.query(api.computers.get, { computerId: ID })).toBeNull();
    expect(await t.query(api.computers.list, { userKey: "user_b" })).toEqual([]);
    for (const p of [
      t.action(api.computers.refresh, { computerId: ID, userKey: "user_b" }),
      t.action(api.computers.start, { computerId: ID, userKey: "user_b" }),
      t.action(api.computers.stop, { computerId: ID }),
      t.action(api.computers.remove, { computerId: ID, userKey: "user_b", allowDelete: true }),
    ]) {
      expect((await errorData(p)).code).toBe("not_found");
    }
    expect(calls).toHaveLength(0);
  });

  test("the owner sees it in get and list, whatever the id's case", async () => {
    const t = initConvexTest();
    await created(t, "user_a");
    expect(
      await t.query(api.computers.get, { computerId: ID.toUpperCase(), userKey: "user_a" }),
    ).toMatchObject({ computerId: ID });
    expect(await t.query(api.computers.list, { userKey: "user_a" })).toHaveLength(1);
  });

  test("a limit that is not a number falls back to the default", async () => {
    const t = initConvexTest();
    await created(t, "user_a");
    expect(await t.query(api.computers.list, { userKey: "user_a", limit: NaN })).toHaveLength(1);
    expect(
      await t.query(api.executions.list, { computerId: ID, userKey: "user_a", limit: NaN }),
    ).toEqual([]);
  });

  test("an id the component never created is not reachable", async () => {
    const t = initConvexTest();
    const { calls } = fakeOrgo({});
    const err = await errorData(
      t.action(api.computers.refresh, { computerId: "11111111-2222-4333-8444-555555555555" }),
    );
    expect(err.code).toBe("not_found");
    expect(calls).toHaveLength(0);
  });
});

describe("refreshComputer", () => {
  test("GET updates the row, without credentials", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({ [`GET /computers/${ID}`]: () => json(fx.fetchedComputer) });
    const c = await t.action(api.computers.refresh, { computerId: ID, userKey: "u" });
    expect(c?.status).toBe("frozen");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /computers/${ID}`]);
    const rows = JSON.stringify(await allRows(t));
    for (const s of fx.SENTINELS) expect(rows).not.toContain(s);
  });

  test("only a 404 marks it gone", async () => {
    const t = initConvexTest();
    await created(t, "u");
    for (const status of [401, 403, 500, 503]) {
      fakeOrgo({ [`GET /computers/${ID}`]: () => json({ error: "x" }, status) });
      await errorData(t.action(api.computers.refresh, { computerId: ID, userKey: "u" }));
      expect((await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.status).toBe(
        "running",
      );
    }
    fakeOrgo({ [`GET /computers/${ID}`]: () => json({ error: "Desktop not found" }, 404) });
    expect(await t.action(api.computers.refresh, { computerId: ID, userKey: "u" })).toBeNull();
    const row = await t.query(api.computers.get, { computerId: ID, userKey: "u" });
    expect(row).toMatchObject({ status: "deleted" });
    expect(row?.deletedAt).toBeTypeOf("number");
    expect(await t.query(api.computers.list, { userKey: "u" })).toEqual([]);
  });

  test("an older observation never overwrites a newer one, and gone stays gone", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const remote = { name: "n", os: "linux", status: "frozen", workspaceId: fx.WORKSPACE_ID };
    const row = await t.query(api.computers.get, { computerId: ID, userKey: "u" });
    const now = row!.observedAt;
    await t.mutation(internal.computers.observe, { computerId: ID, observedAt: now + 10, remote });
    await t.mutation(internal.computers.observe, {
      computerId: ID,
      observedAt: now + 5,
      remote: { ...remote, status: "running" },
    });
    expect((await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.status).toBe(
      "frozen",
    );
    await t.mutation(internal.computers.observe, {
      computerId: ID,
      observedAt: now + 1,
      remote: "gone",
    });
    await t.mutation(internal.computers.observe, {
      computerId: ID,
      observedAt: now + 100,
      remote: { ...remote, status: "running" },
    });
    expect(await t.query(api.computers.get, { computerId: ID, userKey: "u" })).toMatchObject({
      status: "deleted",
    });
  });
});

describe("start and stop", () => {
  test("stop: async POST, polls the operation, refreshes to frozen", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({
      [`POST /computers/${ID}/stop`]: () => json(fx.acceptedLifecycle("stop"), 202),
      [`GET /computers/${ID}/operations/${OP}`]: [
        () => json(fx.operation("stop", "running")),
        () => json(fx.operation("stop", "succeeded")),
      ],
      [`GET /computers/${ID}`]: () => json(fx.fetchedComputer),
    });
    const res = await t.action(api.computers.stop, { computerId: ID, userKey: "u" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /computers/${ID}/stop`,
      `GET /computers/${ID}/operations/${OP}`,
      `GET /computers/${ID}/operations/${OP}`,
      `GET /computers/${ID}`,
    ]);
    expect(calls[0].body).toEqual({ async: true });
    expect(res.pending).toBe(false);
    expect(res.computer?.status).toBe("frozen");
    expect(res.operation).toMatchObject({ id: OP, action: "stop", status: "succeeded" });
    expect(
      (await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.operation?.status,
    ).toBe("succeeded");
  });

  test("a pending start keeps the frozen status until a refresh confirms otherwise", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({ [`GET /computers/${ID}`]: () => json(fx.fetchedComputer) });
    await t.action(api.computers.refresh, { computerId: ID, userKey: "u" }); // now frozen
    const { calls } = fakeOrgo({
      [`POST /computers/${ID}/start`]: () => json(fx.acceptedLifecycle("start"), 202),
    });
    const res = await t.action(api.computers.start, {
      computerId: ID,
      userKey: "u",
      waitSeconds: 0,
    });
    expect(res.pending).toBe(true);
    expect(res.operation).toMatchObject({ action: "start", status: "queued" });
    expect(res.computer?.status).toBe("frozen");
    // No wait: the accepted operation is returned without polling it.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /computers/${ID}/start`]);
  });

  test("a pending stop keeps the running status", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({
      [`POST /computers/${ID}/stop`]: () => json(fx.acceptedLifecycle("stop"), 202),
      [`GET /computers/${ID}/operations/${OP}`]: () => json(fx.operation("stop", "running")),
    });
    const res = await t.action(api.computers.stop, {
      computerId: ID,
      userKey: "u",
      waitSeconds: 0,
    });
    expect(res).toMatchObject({ pending: true, computer: { status: "running" } });
  });

  test.each([
    ["succeeded", null, "frozen"],
    ["failed", { error: "Computer is not running", code: "not_stoppable", status: 409 }, "running"],
  ] as const)(
    "refresh settles a pending stop that %s, without another stop request",
    async (end, error, status) => {
      const t = initConvexTest();
      await created(t, "u");
      fakeOrgo({
        [`POST /computers/${ID}/stop`]: () => json(fx.acceptedLifecycle("stop"), 202),
        [`GET /computers/${ID}/operations/${OP}`]: () => json(fx.operation("stop", "running")),
      });
      await t.action(api.computers.stop, { computerId: ID, userKey: "u", waitSeconds: 0 });
      const { calls } = fakeOrgo({
        [`GET /computers/${ID}/operations/${OP}`]: () => json(fx.operation("stop", end, error)),
        [`GET /computers/${ID}`]: () => json({ ...fx.fetchedComputer, status }),
      });
      const row = await t.action(api.computers.refresh, { computerId: ID, userKey: "u" });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /computers/${ID}/operations/${OP}`,
        `GET /computers/${ID}`,
      ]);
      expect(row?.status).toBe(status);
      expect(row?.operation?.status).toBe(end);
    },
  );

  test("a finished operation is not re-read on refresh", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({
      [`POST /computers/${ID}/stop`]: () => json(fx.acceptedLifecycle("stop"), 202),
      [`GET /computers/${ID}/operations/${OP}`]: () => json(fx.operation("stop", "succeeded")),
      [`GET /computers/${ID}`]: () => json(fx.fetchedComputer),
    });
    await t.action(api.computers.stop, { computerId: ID, userKey: "u" });
    const { calls } = fakeOrgo({ [`GET /computers/${ID}`]: () => json(fx.fetchedComputer) });
    await t.action(api.computers.refresh, { computerId: ID, userKey: "u" });
    expect(calls).toHaveLength(1);
  });

  test("the same operation only moves forward, and keeps its first startedAt", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const base = { id: OP, action: "stop" as const, startedAt: 100, updatedAt: 100 };
    const set = (
      status: "queued" | "running" | "needs_review" | "succeeded" | "failed",
      startedAt = 100,
    ) =>
      t.mutation(internal.computers.setOperation, {
        computerId: ID,
        operation: { ...base, status, startedAt },
      });
    const op = async () =>
      (await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.operation;
    await set("running");
    await set("queued", 200); // a delayed 202 snapshot of the same operation
    expect((await op())?.status).toBe("running");
    await set("succeeded", 300);
    expect(await op()).toMatchObject({ status: "succeeded", startedAt: 100 });
    await set("running", 400); // a slow caller's older observation
    expect((await op())?.status).toBe("succeeded");
    await set("failed");
    expect((await op())?.status).toBe("succeeded");
    // needs_review can still settle; queued after running cannot happen.
    await set("needs_review", 500);
    expect((await op())?.status).toBe("succeeded");
    await t.mutation(internal.computers.setOperation, {
      computerId: ID,
      operation: { ...base, id: fx.COMPUTER_ID, status: "needs_review", startedAt: 600 },
    });
    await set("queued", 550); // another operation that started earlier: ignored
    expect(await op()).toMatchObject({ id: fx.COMPUTER_ID, status: "needs_review" });
  });

  test("a 200 answer (already done) refreshes without polling", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({
      [`POST /computers/${ID}/start`]: () => json({ success: true }),
      [`GET /computers/${ID}`]: () => json({ ...fx.fetchedComputer, status: "running" }),
    });
    const res = await t.action(api.computers.start, { computerId: ID, userKey: "u" });
    expect(res).toMatchObject({ pending: false, computer: { status: "running" } });
    expect(calls).toHaveLength(2);
  });

  test("a failed operation throws Orgo's code and records it", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({
      [`POST /computers/${ID}/stop`]: () => json(fx.acceptedLifecycle("stop"), 202),
      [`GET /computers/${ID}/operations/${OP}`]: () =>
        json(
          fx.operation("stop", "failed", {
            error: "Computer is not running (status: frozen)",
            code: "not_stoppable",
            status: 409,
          }),
        ),
    });
    const err = await errorData(t.action(api.computers.stop, { computerId: ID, userKey: "u" }));
    expect(err).toMatchObject({ code: "conflict", status: 409, orgoCode: "not_stoppable" });
    expect(
      (await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.operation,
    ).toMatchObject({
      status: "failed",
      errorCode: "not_stoppable",
    });
  });

  test("an Orgo refusal before queueing changes nothing", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({
      [`POST /computers/${ID}/stop`]: () =>
        json(
          { error: "Choose a plan to archive this computer.", code: "TRIAL_ARCHIVE_UNAVAILABLE" },
          402,
        ),
    });
    const err = await errorData(t.action(api.computers.stop, { computerId: ID, userKey: "u" }));
    expect(err).toMatchObject({ code: "payment_required", orgoCode: "TRIAL_ARCHIVE_UNAVAILABLE" });
    const row = await t.query(api.computers.get, { computerId: ID, userKey: "u" });
    expect(row?.operation).toBeUndefined();
    expect(row?.status).toBe("running");
  });

  test("waitSeconds outside 0..300 is refused before any fetch", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({});
    expect(
      (
        await errorData(
          t.action(api.computers.start, { computerId: ID, userKey: "u", waitSeconds: 301 }),
        )
      ).code,
    ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });
});

describe("deleteComputer", () => {
  test("refused by default with zero fetches and no state change", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({});
    const err = await errorData(
      t.action(api.computers.remove, { computerId: ID, userKey: "u", allowDelete: false }),
    );
    expect(err.code).toBe("delete_not_allowed");
    expect(calls).toHaveLength(0);
    expect(
      (await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.deletedAt,
    ).toBeUndefined();
  });

  test("allowed: DELETE, then a tombstone", async () => {
    const t = initConvexTest();
    await created(t, "u");
    const { calls } = fakeOrgo({ [`DELETE /computers/${ID}`]: () => json({ success: true }) });
    expect(
      await t.action(api.computers.remove, { computerId: ID, userKey: "u", allowDelete: true }),
    ).toEqual({ deleted: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /computers/${ID}`]);
    expect(await t.query(api.computers.get, { computerId: ID, userKey: "u" })).toMatchObject({
      status: "deleted",
    });
    expect(await t.query(api.computers.list, { userKey: "u" })).toEqual([]);
  });

  test("an empty 204 answer still records the delete", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({ [`DELETE /computers/${ID}`]: () => new Response(null, { status: 204 }) });
    await t.action(api.computers.remove, { computerId: ID, userKey: "u", allowDelete: true });
    expect(await t.query(api.computers.get, { computerId: ID, userKey: "u" })).toMatchObject({
      status: "deleted",
    });
  });

  test("a refused delete (409) keeps the computer", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({
      [`DELETE /computers/${ID}`]: () =>
        json(
          { error: "Manage this computer in Account → Usage.", code: "ALLOCATION_MANAGED" },
          409,
        ),
    });
    const err = await errorData(
      t.action(api.computers.remove, { computerId: ID, userKey: "u", allowDelete: true }),
    );
    expect(err).toMatchObject({ code: "conflict", orgoCode: "ALLOCATION_MANAGED" });
    expect((await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.status).toBe(
      "running",
    );
  });

  test("already gone in Orgo (404) still tombstones", async () => {
    const t = initConvexTest();
    await created(t, "u");
    fakeOrgo({ [`DELETE /computers/${ID}`]: () => json({ error: "Desktop not found" }, 404) });
    await t.action(api.computers.remove, { computerId: ID, userKey: "u", allowDelete: true });
    expect((await t.query(api.computers.get, { computerId: ID, userKey: "u" }))?.status).toBe(
      "deleted",
    );
  });
});
