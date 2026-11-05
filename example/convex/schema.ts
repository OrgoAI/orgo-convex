import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /** The one computer the public demo drives (a single row). */
  demo: defineTable({
    computerId: v.string(),
    setupAt: v.number(),
    /** Set by the operator (demo:pause) to refuse every public action. */
    paused: v.optional(v.boolean()),
  }),
  /** The latest screenshot, kept in Convex file storage. */
  screenshots: defineTable({
    storageId: v.id("_storage"),
    width: v.number(),
    height: v.number(),
    takenAt: v.number(),
  }),
  /** One row: when the last public action ran, and how many ran today (UTC). */
  // day and count are optional so a row written before the daily cap existed still loads.
  throttle: defineTable({
    lastAt: v.number(),
    day: v.optional(v.string()),
    count: v.optional(v.number()),
  }),
});
