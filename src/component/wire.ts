// Parsers for Orgo's responses. Each reads only the fields the component
// uses, so credentials Orgo includes (vnc_password, instance_details with its
// desktopApiToken, connection URLs) never reach a table or a return value.
// Contracts: https://docs.orgo.ai/api-reference
import { orgoError, safeCode, sanitizeMessage, UUID_RE } from "./orgoApi.js";

type Json = Record<string, unknown>;

function object(body: unknown, what: string): Json {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw orgoError("invalid_response", `Orgo's ${what} response is not an object.`);
  }
  return body as Json;
}

function str(o: Json, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") {
    throw orgoError("invalid_response", `Orgo's ${what} response has no ${key}.`);
  }
  return v;
}

function optStr(o: Json, key: string): string | undefined {
  return typeof o[key] === "string" ? (o[key] as string) : undefined;
}

export interface RemoteComputer {
  id: string;
  name: string;
  workspaceId: string;
  os: string;
  status: string;
  createdAt?: string;
}

/** POST /api/computers (201) and GET /api/computers/{id}. */
export function parseComputer(body: unknown): RemoteComputer {
  const o = object(body, "computer");
  // Create answers workspace_id and project_id; GET answers project_id only.
  const workspaceId = optStr(o, "workspace_id") ?? optStr(o, "project_id");
  if (!workspaceId) {
    throw orgoError("invalid_response", "Orgo's computer response has no workspace id.");
  }
  return {
    id: str(o, "id", "computer"),
    name: str(o, "name", "computer"),
    workspaceId,
    os: str(o, "os", "computer"),
    status: str(o, "status", "computer"),
    createdAt: optStr(o, "created_at"),
  };
}

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_review",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export interface RemoteOperation {
  id: string;
  action: "start" | "stop";
  status: OperationStatus;
  errorCode?: string;
  error?: string;
  /** The HTTP status Orgo gives the failure, e.g. 409. */
  errorStatus?: number;
}

/**
 * GET /api/computers/{id}/operations/{operationId}, and `operation` in a
 * 202. `apiKey` is redacted from the failure text, which gets stored.
 */
export function parseOperation(body: unknown, apiKey?: string): RemoteOperation {
  const o = object(body, "operation");
  const status = o.status;
  if (!OPERATION_STATUSES.includes(status as OperationStatus)) {
    throw orgoError("invalid_response", "Orgo's operation response has an unknown status.");
  }
  const action = o.action;
  if (action !== "start" && action !== "stop") {
    throw orgoError("invalid_response", "Orgo's operation is not a start or stop.");
  }
  const id = o.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw orgoError("invalid_response", "Orgo's operation has no valid id.");
  }
  const err = typeof o.error === "object" && o.error !== null ? (o.error as Json) : undefined;
  return {
    id: id.toLowerCase(),
    action,
    status: status as OperationStatus,
    // Stored on the row and thrown to the host: same treatment as any Orgo error.
    errorCode: err ? safeCode(err.code, apiKey) : undefined,
    error:
      err && typeof err.error === "string"
        ? sanitizeMessage(err.error, apiKey) || undefined
        : undefined,
    errorStatus: err && typeof err.status === "number" ? err.status : undefined,
  };
}

export type LifecycleAnswer = { kind: "done" } | { kind: "accepted"; operation: RemoteOperation };

/**
 * POST /api/computers/{id}/start|stop. 200 is the finished operation's
 * result (`{success: true, ...}`); 202 is accepted work to poll.
 */
export function parseLifecycle(
  status: number,
  body: unknown,
  action: "start" | "stop",
  apiKey?: string,
): LifecycleAnswer {
  const o = object(body, action);
  if (status === 202) {
    // Orgo answers with the operation, or at least its id.
    const operation =
      typeof o.operation === "object" && o.operation !== null
        ? o.operation
        : { id: o.operation_id, action, status: "queued" };
    return { kind: "accepted", operation: parseOperation(operation, apiKey) };
  }
  if (o.success === true) return { kind: "done" };
  throw orgoError("invalid_response", `Orgo's ${action} response did not report success.`);
}

/**
 * A guest's answer to bash or exec, as Orgo forwards it. Linux bash:
 * `{success, output, exit_code}` (success means "it ran"; a timeout is
 * exit_code -1 with no flag). Linux exec: `{success, output}` with success
 * true only on exit 0 and no exit code. Windows (both): `{stdout, stderr,
 * exit_code, output, error?}`, a timeout being exit_code 124 + error "timeout".
 */
export interface GuestResult {
  output: string;
  exitCode?: number;
  /** The guest's own `success` flag, when it sent one. */
  success?: boolean;
  /** The guest said the run timed out (Windows only sends this). */
  timedOut: boolean;
}

export function parseGuestResult(body: unknown, what: "command" | "python"): GuestResult {
  const o = object(body, what);
  let output = optStr(o, "output");
  if (output === undefined) {
    // No combined output: join the streams the way Orgo's docs describe.
    const parts = [optStr(o, "stdout"), optStr(o, "stderr")].filter(
      (p): p is string => p !== undefined && p !== "",
    );
    output = parts.join("\n");
  }
  const exit = o.exit_code;
  const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
  const success = typeof o.success === "boolean" ? o.success : undefined;
  // A shell's success flag only means the command ran, so a command needs an
  // exit code (or a timeout); Python on Linux reports success alone.
  const known =
    o.error === "timeout" || exitCode !== undefined || (what === "python" && success !== undefined);
  if (!known) {
    throw orgoError("invalid_response", `Orgo's ${what} response does not say how the run ended.`);
  }
  return { output, exitCode, success, timedOut: o.error === "timeout" };
}

/** POST /api/files/upload with destPath: `{ok: true, placedIn}`. */
export function parseUpload(body: unknown): { placedIn: string } {
  const o = object(body, "upload");
  if (o.ok !== true) {
    throw orgoError("invalid_response", "Orgo's upload response did not report success.");
  }
  return { placedIn: str(o, "placedIn", "upload") };
}

export interface RemoteExport {
  /** Signed, one-hour download link. Never stored or logged. */
  url: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * The workspace file record an export created, if any, read on its own so
 * the copy can be cleaned up even when the rest of the answer is malformed.
 */
export function exportedFileId(body: unknown): string | undefined {
  const file = (body as { file?: { id?: unknown } } | null)?.file;
  const id = typeof file === "object" && file !== null ? file.id : undefined;
  return typeof id === "string" && UUID_RE.test(id) ? id : undefined;
}

/** POST /api/files/export: `{success, file: {id?, size_bytes: "<decimal>", ...}, url}`. */
export function parseExport(body: unknown): RemoteExport {
  const o = object(body, "export");
  if (o.success !== true) {
    throw orgoError("invalid_response", "Orgo's export response did not report success.");
  }
  const file = object(o.file, "export file");
  const raw = file.size_bytes;
  const sizeBytes = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw orgoError("invalid_response", "Orgo's export response has no file size.");
  }
  return {
    url: str(o, "url", "export"),
    sizeBytes,
    contentType: optStr(file, "content_type"),
  };
}
