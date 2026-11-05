/// <reference types="vite/client" />
import { expect, test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import { api } from "./_generated/api.js";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  return convexTest(schema, modules);
}

test("the component's schema and modules load", async () => {
  const t = initConvexTest();
  expect(await t.query(api.computers.list, {})).toEqual([]);
});
