import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { defineTestApp } from "convex-test";
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import { Orgo, orgoErrorData } from "./index.js";
import componentTest from "../test.js";
import type { ComponentApi } from "../component/_generated/component.js";
import * as fx from "../fixtures/orgo.js";
import { fakeOrgo, json, resetOrgo, useOrgoEnv } from "../fixtures/fakeOrgo.js";

// A host app that installs the component under a non-default name and
// derives userKey from the signed-in user, as the README recommends.
const app = defineTestApp({
  schema: defineSchema({}),
  components: { computers: componentTest },
});
const orgo = new Orgo(app.components.computers);

async function userKey(ctx: {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier: string } | null> };
}) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");
  return identity.tokenIdentifier;
}

const { api, createTest } = app.defineModules({
  host: {
    create: app.action({
      args: {},
      handler: async (ctx) =>
        orgo.createComputer(ctx, {
          workspaceId: fx.WORKSPACE_ID,
          name: "mine",
          userKey: await userKey(ctx),
        }),
    }),
    mine: app.query({
      args: {},
      handler: async (ctx) => orgo.listComputers(ctx, { userKey: await userKey(ctx) }),
    }),
    one: app.query({
      args: { computerId: v.string() },
      handler: async (ctx, args) => orgo.getComputer(ctx, { ...args, userKey: await userKey(ctx) }),
    }),
    remove: app.action({
      args: { computerId: v.string() },
      returns: v.union(v.null(), v.string()),
      handler: async (ctx, args) => {
        try {
          await orgo.deleteComputer(ctx, { ...args, userKey: await userKey(ctx) });
          return null;
        } catch (e) {
          // The structured error survives the component boundary.
          return orgoErrorData(e)?.code ?? "not an OrgoError";
        }
      },
    }),
  },
});

beforeEach(() => useOrgoEnv());
afterEach(() => resetOrgo());

describe("Orgo client in a host app", () => {
  test("is typed for the name it is installed under", () => {
    expectTypeOf(app.components.computers).toEqualTypeOf<ComponentApi<"computers">>();
  });

  test("scopes computers to the signed-in user", async () => {
    fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
    const t = createTest();
    const asAlice = t.withIdentity({ tokenIdentifier: "alice" });
    const asBob = t.withIdentity({ tokenIdentifier: "bob" });
    const created = await asAlice.action(api.host.create, {});
    expect(created).toMatchObject({ computerId: fx.COMPUTER_ID, userKey: "alice" });
    expect(await asAlice.query(api.host.mine, {})).toHaveLength(1);
    expect(await asBob.query(api.host.mine, {})).toEqual([]);
    expect(await asBob.query(api.host.one, { computerId: fx.COMPUTER_ID })).toBeNull();
  });

  test("deleteComputer is refused by default, as structured error data", async () => {
    const t = createTest();
    fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
    const asAlice = t.withIdentity({ tokenIdentifier: "alice" });
    await asAlice.action(api.host.create, {});
    const { calls } = fakeOrgo({});
    expect(await asAlice.action(api.host.remove, { computerId: fx.COMPUTER_ID })).toBe(
      "delete_not_allowed",
    );
    expect(calls).toHaveLength(0);
  });
});
