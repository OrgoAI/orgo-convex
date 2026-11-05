import { defineApp } from "convex/server";
import { v } from "convex/values";
import orgo from "orgo-convex/convex.config.js";

const app = defineApp({
  env: {
    ORGO_API_KEY: v.string(),
    ORGO_API_URL: v.optional(v.string()),
  },
});
app.use(orgo, {
  env: {
    ORGO_API_KEY: app.env.ORGO_API_KEY,
    ORGO_API_URL: app.env.ORGO_API_URL,
  },
});

export default app;
