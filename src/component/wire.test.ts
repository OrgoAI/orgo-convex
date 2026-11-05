import { describe, expect, test } from "vitest";
import { isOrgoError } from "./orgoApi.js";
import {
  exportedFileId,
  parseComputer,
  parseExport,
  parseGuestResult,
  parseLifecycle,
  parseOperation,
  parseUpload,
} from "./wire.js";
import * as fx from "../fixtures/orgo.js";

function code(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (isOrgoError(e)) return e.data.code;
    throw e;
  }
  throw new Error("expected an OrgoError");
}

describe("parseComputer", () => {
  test("create response: allow-listed fields only, no credentials", () => {
    const c = parseComputer(fx.createdComputer);
    expect(c).toEqual({
      id: fx.COMPUTER_ID,
      name: "convex-test",
      workspaceId: fx.WORKSPACE_ID,
      os: "linux",
      status: "running",
      createdAt: "2026-10-20T23:00:00.000Z",
    });
    for (const s of fx.SENTINELS) expect(JSON.stringify(c)).not.toContain(s);
  });

  test("GET response carries only project_id; it becomes workspaceId", () => {
    const c = parseComputer(fx.fetchedComputer);
    expect(c.workspaceId).toBe(fx.WORKSPACE_ID);
    expect(c.status).toBe("frozen");
    expect(JSON.stringify(c)).not.toContain(fx.SECRET.vncPassword);
  });

  test("an unknown status is kept, not rejected", () => {
    expect(parseComputer({ ...fx.fetchedComputer, status: "waking" }).status).toBe("waking");
  });

  test.each([
    ["no id", { ...fx.createdComputer, id: undefined }],
    ["no workspace", { ...fx.fetchedComputer, project_id: undefined }],
    ["not an object", [fx.createdComputer]],
    ["null", null],
  ])("%s → invalid_response", (_, body) => {
    expect(code(() => parseComputer(body))).toBe("invalid_response");
  });
});

describe("lifecycle", () => {
  test("202 is accepted work with its operation", () => {
    expect(parseLifecycle(202, fx.acceptedLifecycle("stop"), "stop")).toEqual({
      kind: "accepted",
      operation: { id: fx.OPERATION_ID, action: "stop", status: "queued" },
    });
  });

  test("202 without an operation object falls back to operation_id", () => {
    const { operation: _op, ...rest } = fx.acceptedLifecycle("start");
    expect(parseLifecycle(202, rest, "start")).toEqual({
      kind: "accepted",
      operation: { id: fx.OPERATION_ID, action: "start", status: "queued" },
    });
  });

  test("200 with success is done", () => {
    expect(parseLifecycle(200, { success: true, reconciled: true }, "start")).toEqual({
      kind: "done",
    });
  });

  test("200 without success is invalid_response", () => {
    expect(code(() => parseLifecycle(200, { ok: true }, "start"))).toBe("invalid_response");
  });

  test.each(["queued", "running", "succeeded", "failed", "needs_review"] as const)(
    "operation status %s",
    (status) => {
      expect(parseOperation(fx.operation("start", status)).status).toBe(status);
    },
  );

  test("a failed operation keeps Orgo's code and message", () => {
    const op = parseOperation(
      fx.operation("stop", "failed", {
        error: "Computer is not running",
        code: "not_stoppable",
        status: 409,
      }),
    );
    expect(op).toMatchObject({
      status: "failed",
      errorCode: "not_stoppable",
      error: "Computer is not running",
    });
  });

  test("a failed operation's message and code are sanitized like any Orgo error", () => {
    const op = parseOperation(
      fx.operation("stop", "failed", {
        error: `See ${fx.SECRET.signedUrl} with sk_live_abcdefghijklmnop\nnext`,
        code: "<script>",
        status: 409,
      }),
    );
    expect(op.error).toBe("See [url] with [redacted] next");
    expect(op.errorCode).toBeUndefined();
    for (const s of fx.SENTINELS) expect(JSON.stringify(op)).not.toContain(s);
  });

  test("a failed operation never keeps a configured key of any shape", () => {
    const key = "fixture-key-for-review";
    const op = parseOperation(
      fx.operation("stop", "failed", { error: `denied for ${key}`, code: key, status: 403 }),
      key,
    );
    expect(op.error).toBe("denied for [redacted]");
    expect(op.errorCode).toBeUndefined();
    expect(JSON.stringify(op)).not.toContain(key);
  });

  test("an operation id that is not a UUID is invalid_response", () => {
    expect(code(() => parseOperation({ ...fx.operation("start", "queued"), id: "op/../x" }))).toBe(
      "invalid_response",
    );
    const { operation: _op, ...rest } = fx.acceptedLifecycle("start");
    expect(code(() => parseLifecycle(202, { ...rest, operation_id: 7 }, "start"))).toBe(
      "invalid_response",
    );
  });

  test("an unknown operation status is invalid_response", () => {
    expect(
      code(() => parseOperation({ ...fx.operation("start", "queued"), status: "paused" })),
    ).toBe("invalid_response");
  });
});

describe("parseGuestResult", () => {
  test("Linux bash success", () => {
    expect(parseGuestResult(fx.bashLinuxOk, "command")).toEqual({
      output: "hello",
      exitCode: 0,
      success: true,
      timedOut: false,
    });
  });

  test("Linux bash nonzero exit keeps success:true (it ran) and exit 3", () => {
    expect(parseGuestResult(fx.bashLinuxExit3, "command")).toMatchObject({
      exitCode: 3,
      success: true,
    });
  });

  test("Linux bash killed by timeout: exit -1, no flag", () => {
    expect(parseGuestResult(fx.bashLinuxKilled, "command")).toMatchObject({
      exitCode: -1,
      timedOut: false,
    });
  });

  test("Windows timeout flag", () => {
    expect(parseGuestResult(fx.bashWindowsTimeout, "command")).toEqual({
      output: "partial",
      exitCode: 124,
      success: undefined,
      timedOut: true,
    });
  });

  test("Windows separate streams without combined output are joined, never invented", () => {
    expect(parseGuestResult(fx.bashWindowsStreams, "command").output).toBe("out\nerr");
    expect(parseGuestResult({ stdout: "only", exit_code: 0 }, "command").output).toBe("only");
  });

  test("Linux exec has no exit code", () => {
    expect(parseGuestResult(fx.execLinuxOk, "python")).toEqual({
      output: "42",
      exitCode: undefined,
      success: true,
      timedOut: false,
    });
    expect(parseGuestResult(fx.execLinuxRaised, "python")).toMatchObject({ success: false });
  });

  test("a non-integer exit code is ignored, and with nothing else it is an unknown outcome", () => {
    // A command needs an exit code: bash's success flag only means "it ran".
    for (const body of [
      {},
      { output: "x" },
      { output: "", exit_code: "0" },
      { success: "yes" },
      { success: true },
      { success: true, exit_code: "2" },
    ]) {
      expect(code(() => parseGuestResult(body, "command"))).toBe("invalid_response");
    }
    // Python on Linux reports success alone; that is a known outcome.
    expect(parseGuestResult({ output: "", exit_code: "0", success: true }, "python")).toMatchObject(
      { exitCode: undefined, success: true },
    );
    expect(code(() => parseGuestResult({ output: "" }, "python"))).toBe("invalid_response");
  });
});

describe("files", () => {
  test("upload placement", () => {
    expect(parseUpload(fx.uploadPlaced)).toEqual({ placedIn: "/tmp" });
    expect(code(() => parseUpload({ file: {} }))).toBe("invalid_response");
  });

  test("export: decimal-string size and signed URL", () => {
    expect(parseExport(fx.exported)).toEqual({
      url: fx.SECRET.signedUrl,
      sizeBytes: 5,
      contentType: "text/plain",
    });
  });

  test("export file id is read on its own, and only when it is a UUID", () => {
    expect(exportedFileId(fx.exported)).toBe(fx.exported.file.id);
    expect(exportedFileId({ file: { id: fx.exported.file.id, size_bytes: "big" } })).toBe(
      fx.exported.file.id,
    );
    expect(exportedFileId({ file: { id: "../etc" } })).toBeUndefined();
    expect(exportedFileId({ success: true })).toBeUndefined();
    expect(exportedFileId(null)).toBeUndefined();
  });

  test("export without a usable size is invalid_response", () => {
    expect(code(() => parseExport({ ...fx.exported, file: { size_bytes: "big" } }))).toBe(
      "invalid_response",
    );
  });
});
