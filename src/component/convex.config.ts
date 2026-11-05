import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("orgo", {
  env: {
    // Components cannot read the app's environment variables, so the app
    // passes these down in its convex.config.ts (see README).
    // Your Orgo API key (https://www.orgo.ai/settings/credentials).
    ORGO_API_KEY: v.string(),
    // Origin of the Orgo API. Defaults to https://www.orgo.ai. Origin only:
    // the component adds the /api prefix itself.
    ORGO_API_URL: v.optional(v.string()),
  },
});
