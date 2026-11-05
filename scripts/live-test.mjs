#!/usr/bin/env node
// End-to-end test against a real Orgo workspace, through a real Convex
// deployment (the one `npx convex dev` uses; CONVEX_AGENT_MODE=anonymous for a
// local one). It creates one computer, exercises every feature and deletes the
// computer at the end, whatever happened.
//
//   ORGO_API_KEY=sk_live_... ORGO_WORKSPACE_ID=<uuid> npm run test:live
//
// Use a scratch workspace: never one with computers doing real work.
// Optional: ORGO_API_URL for a non-production Orgo origin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const { ORGO_API_KEY, ORGO_WORKSPACE_ID, ORGO_API_URL } = process.env;
if (!ORGO_API_KEY || !ORGO_WORKSPACE_ID) {
  console.error("Set ORGO_API_KEY and ORGO_WORKSPACE_ID (a scratch workspace).");
  process.exit(2);
}
const origin = ORGO_API_URL || "https://www.orgo.ai";
const OWNER = "live-test-owner";
const MIB = 1024 * 1024;

function convex(args, input) {
  return execFileSync("npx", ["convex", ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * MIB,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Runs liveProof:<fn> and returns its result. */
function run(fn, args = {}) {
  const out = convex(["run", `liveProof:${fn}`, JSON.stringify(args)]);
  return out.trim() ? JSON.parse(out) : null;
}

/** Runs liveProof:<fn> expecting it to throw; returns the error text. */
function runFails(fn, args) {
  try {
    run(fn, args);
  } catch (e) {
    return String(e.stderr ?? e);
  }
  throw new Error(`liveProof:${fn} should have failed`);
}

let passed = 0;
function check(name, ok, detail) {
  if (!ok)
    throw new Error(
      `FAILED: ${name}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
    );
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Pseudo-random bytes identical to liveProof's `pattern` (xorshift32). */
function pattern(size) {
  const out = new Uint8Array(size);
  let x = 2463534242;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

console.log("Deploying to the current Convex deployment...");
convex(["env", "set", "ORGO_API_KEY"], ORGO_API_KEY);
// The deployment must call the same Orgo origin this script checks directly.
if (ORGO_API_URL) convex(["env", "set", "ORGO_API_URL", ORGO_API_URL]);
else convex(["env", "remove", "ORGO_API_URL"]);
execFileSync("npm", ["run", "build"], { stdio: "ignore" });
convex(["dev", "--once", "--typecheck-components"]);

const name = `orgo-convex-live-${Date.now()}`;
console.log(`Creating ${name}...`);
const computer = run("create", { workspaceId: ORGO_WORKSPACE_ID, name, userKey: OWNER });
const owned = { computerId: computer.computerId, userKey: OWNER };
let deleted = false;

try {
  console.log("Computers");
  check("create returns a running computer", computer.status === "running", computer);
  check("no credentials in the row", !/password|token|https?:\/\//i.test(JSON.stringify(computer)));
  check("owner can read it", run("get", owned)?.computerId === computer.computerId);
  check("another userKey cannot", run("get", { ...owned, userKey: "someone-else" }) === null);
  check(
    "listed for its owner",
    run("list", { userKey: OWNER }).some((c) => c.computerId === computer.computerId),
  );

  console.log("Commands");
  const hello = run("runCommand", { ...owned, command: "echo hello" });
  check(
    "echo succeeds",
    hello.status === "succeeded" && hello.exitCode === 0 && hello.output.includes("hello"),
    hello,
  );
  const exit3 = run("runCommand", { ...owned, command: "exit 3" });
  check(
    "non-zero exit is failed with its code",
    exit3.status === "failed" && exit3.exitCode === 3,
    exit3,
  );
  const slow = run("runCommand", { ...owned, command: "sleep 30", timeoutSeconds: 5 });
  check("a command past its timeout is timed_out", slow.status === "timed_out", slow);
  const py = run("runPython", { ...owned, code: "print(6 * 7)" });
  check("python prints", py.status === "succeeded" && py.output.trim() === "42", py);
  const raise = run("runPython", { ...owned, code: "raise ValueError('boom')" });
  check(
    "python exception is failed",
    raise.status === "failed" && raise.output.includes("ValueError"),
    raise,
  );
  const history = run("listExecutions", owned);
  check("history has every run", history.length === 5, history.length);
  check(
    "history keeps no output by default",
    history.every((r) => r.output === undefined && r.input === undefined),
  );
  const kept = run("runCommand", { ...owned, command: "echo kept", retain: true });
  const keptRow = run("listExecutions", owned).find((r) => r._id === kept.executionId);
  check(
    "retainOutput keeps the command and its output",
    keptRow?.input === "echo kept" && keptRow?.output?.includes("kept"),
    keptRow,
  );

  console.log("Screen and files");
  const shot = run("screenshotInfo", owned);
  check(
    "screenshot is a PNG",
    shot.magic === "89 50 4e 47 0d 0a 1a 0a" && shot.width > 0 && shot.height > 0,
    {
      ...shot,
      base64: undefined,
    },
  );
  const text = "héllo from convex ✓\n";
  run("uploadText", { ...owned, path: "/tmp/orgo-convex-live/ünïcode.txt", text });
  const textBack = run("exportInfo", { ...owned, path: "/tmp/orgo-convex-live/ünïcode.txt" });
  check("text round trip is exact", textBack.text === text, textBack);
  const size = 3 * MIB;
  const up = run("uploadPattern", { ...owned, path: "/tmp/orgo-convex-live/blob.bin", size });
  const back = run("exportInfo", {
    ...owned,
    path: "/tmp/orgo-convex-live/blob.bin",
    maxBytes: 4 * MIB,
  });
  check(
    "3 MiB binary round trip matches SHA-256",
    back.sizeBytes === size && back.sha256 === up.sha256 && up.sha256 === sha256(pattern(size)),
    { up, back },
  );
  const tooBig = run("expectFailure", {
    ...owned,
    what: "exportTooBig",
    path: "/tmp/orgo-convex-live/blob.bin",
  });
  check("export over maxBytes is too_large", tooBig.code === "too_large", tooBig);
  const oversize = run("expectFailure", {
    ...owned,
    what: "oversizeUpload",
    path: "/tmp/orgo-convex-live/big.bin",
  });
  check("upload over 10 MiB is refused", oversize.code === "too_large", oversize);

  console.log("Stop and start");
  const stopping = run("stop", { ...owned, waitSeconds: 0 });
  check(
    "stop with no wait is pending",
    stopping.pending === true && stopping.operation?.action === "stop",
    stopping,
  );
  let settled = null;
  for (let i = 0; i < 90 && !settled; i++) {
    const c = run("refresh", owned);
    if (c?.operation && ["succeeded", "failed"].includes(c.operation.status)) settled = c;
    else await new Promise((r) => setTimeout(r, 2000));
  }
  check(
    "refresh settles the stop",
    settled?.operation.status === "succeeded" && settled.status === "frozen",
    settled,
  );
  const started = run("start", { ...owned, waitSeconds: 240 });
  check(
    "start waits until running",
    started.pending === false && started.computer?.status === "running",
    started,
  );
  const after = run("runCommand", { ...owned, command: "echo back" });
  check("commands run after a restart", after.status === "succeeded", after);

  console.log("Delete");
  check(
    "delete is refused by default",
    runFails("deleteDefault", owned).includes("delete_not_allowed"),
  );
  check("delete with allowDelete", run("deleteAllowed", owned)?.deleted === true);
  deleted = true;
  const res = await fetch(`${origin}/api/computers/${computer.computerId}`, {
    headers: { Authorization: `Bearer ${ORGO_API_KEY}` },
  });
  check("Orgo answers 404 for the deleted computer", res.status === 404, res.status);

  console.log("Tables");
  const tables =
    convex([
      "data",
      "computers",
      "--component",
      "orgo",
      "--limit",
      "1000",
      "--format",
      "jsonLines",
    ]) +
    convex([
      "data",
      "executions",
      "--component",
      "orgo",
      "--limit",
      "1000",
      "--format",
      "jsonLines",
    ]);
  check(
    "component tables hold no credentials or links",
    !/vnc|password|desktopApiToken|sk_live|https?:\/\//i.test(tables),
  );
} finally {
  if (!deleted) {
    console.log("Cleaning up: deleting the test computer.");
    try {
      run("deleteAllowed", owned);
    } catch {
      console.error(`Could not delete ${computer.computerId}; delete it in the Orgo dashboard.`);
    }
  }
}
console.log(`\nAll ${passed} live checks passed.`);
