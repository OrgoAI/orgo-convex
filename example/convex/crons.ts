import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval(
  "clear demo run history older than a day",
  { hours: 1 },
  internal.demo.purgeHistory,
  {},
);
export default crons;
