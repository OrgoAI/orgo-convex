/// <reference types="vite/client" />
import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import component from "orgo-convex/test";
import { internal } from "./_generated/api.js";

const modules = import.meta.glob("./**/*.*s");
// Apps that test code using the component register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  return t;
}

test("an app registers the component with orgo-convex/test and calls it", async () => {
  const t = initConvexTest();
  expect(await t.query(internal.liveProof.list, { userKey: "nobody" })).toEqual([]);
});
