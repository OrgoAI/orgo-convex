// HTTP access to the Orgo API: one place for the base URL, the bearer
// header, deadlines, byte caps and error mapping. Plain fetch, so it runs in
// Convex's default runtime.
//
// Errors are ConvexErrors carrying an `OrgoErrorData` so a host app can read
// `error.data.code` across the component boundary. They hold Orgo's own
// short message and code, never a raw response body, a URL or the API key.
import { ConvexError } from "convex/values";

export const DEFAULT_ORGO_API_URL = "https://www.orgo.ai";
const MIB = 1024 * 1024;
/** Default cap on a response body the component reads. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * MIB;
/** Cap on an error body: only its `error` and `code` fields are kept. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 300;

export type OrgoErrorCode =
  | "config"
  | "invalid_argument"
  | "not_found"
  | "delete_not_allowed"
  | "bad_request"
  | "unauthorized"
  | "payment_required"
  | "forbidden"
  | "conflict"
  | "too_large"
  | "unprocessable"
  | "rate_limited"
  | "not_implemented"
  | "server_error"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_response";

export type OrgoErrorData = {
  kind: "OrgoError";
  code: OrgoErrorCode;
  message: string;
  /** HTTP status Orgo answered with, when it answered. */
  status?: number;
  /** Orgo's own error code, e.g. `not_stoppable`. */
  orgoCode?: string;
  /** Seconds to wait before retrying, from Orgo's Retry-After. */
  retryAfterSeconds?: number;
};

export function orgoError(
  code: OrgoErrorCode,
  message: string,
  extra: { status?: number; orgoCode?: string; retryAfterSeconds?: number } = {},
): ConvexError<OrgoErrorData> {
  const data: OrgoErrorData = { kind: "OrgoError", code, message };
  if (extra.status !== undefined) data.status = extra.status;
  if (extra.orgoCode !== undefined) data.orgoCode = extra.orgoCode;
  if (extra.retryAfterSeconds !== undefined) {
    data.retryAfterSeconds = extra.retryAfterSeconds;
  }
  return new ConvexError(data);
}

export function isOrgoError(e: unknown): e is ConvexError<OrgoErrorData> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { kind?: unknown }).kind === "OrgoError"
  );
}

/** True when the request may have reached Orgo and its outcome is unknown. */
export function outcomeUnknown(e: unknown): boolean {
  if (!isOrgoError(e)) return true;
  return ["timeout", "network", "unavailable", "server_error", "invalid_response"].includes(
    e.data.code,
  );
}

export interface OrgoConfig {
  apiKey: string;
  /** Origin only, no trailing slash, e.g. https://www.orgo.ai. */
  origin: string;
}

/** Reads the component env. Throws a `config` error that names the fix. */
export function resolveConfig(env: { ORGO_API_KEY?: string; ORGO_API_URL?: string }): OrgoConfig {
  const apiKey = env.ORGO_API_KEY?.trim();
  if (!apiKey) {
    throw orgoError(
      "config",
      "ORGO_API_KEY is not set. Set it on your deployment (npx convex env set ORGO_API_KEY ...) and pass it to the component in convex.config.ts: app.use(orgo, { env: { ORGO_API_KEY: app.env.ORGO_API_KEY } }).",
    );
  }
  return { apiKey, origin: normalizeOrigin(env.ORGO_API_URL) };
}

export function normalizeOrigin(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_ORGO_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw orgoError(
      "config",
      "ORGO_API_URL is not a URL. Use an origin such as https://www.orgo.ai.",
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw orgoError("config", "ORGO_API_URL must use https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw orgoError("config", "ORGO_API_URL must be a plain origin such as https://www.orgo.ai.");
  }
  if (url.pathname !== "/") {
    throw orgoError(
      "config",
      "ORGO_API_URL must be an origin such as https://www.orgo.ai, without a path: the component adds /api itself.",
    );
  }
  return url.origin;
}

export interface OrgoRequest {
  method: "GET" | "POST" | "DELETE";
  /** Path under /api, starting with a slash, e.g. `/computers/<id>`. */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  timeoutMs: number;
  maxResponseBytes?: number;
}

export interface OrgoJsonResponse {
  status: number;
  body: unknown;
}

export interface OrgoBytesResponse {
  status: number;
  bytes: ArrayBuffer;
  contentType: string | null;
}

export type FetchFn = typeof fetch;

/** Calls Orgo and parses a JSON body (null when empty). Non-2xx throws an OrgoError. */
export async function orgoJson(
  config: OrgoConfig,
  req: OrgoRequest,
  fetchFn: FetchFn = fetch,
): Promise<OrgoJsonResponse> {
  return await exchange(req.timeoutMs, async (signal) => {
    const res = await send(config, req, fetchFn, "application/json", signal);
    const bytes = await readBounded(
      res,
      req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      signal,
    );
    if (bytes.byteLength === 0) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      throw orgoError("invalid_response", "Orgo answered with a body that is not JSON.", {
        status: res.status,
      });
    }
  });
}

/** Calls Orgo and returns the raw body (e.g. a binary screenshot). */
export async function orgoBytes(
  config: OrgoConfig,
  req: OrgoRequest,
  fetchFn: FetchFn = fetch,
): Promise<OrgoBytesResponse> {
  return await exchange(req.timeoutMs, async (signal) => {
    const res = await send(config, req, fetchFn, "*/*", signal);
    const bytes = await readBounded(
      res,
      req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      signal,
    );
    return {
      status: res.status,
      bytes: toArrayBuffer(bytes),
      contentType: res.headers.get("content-type"),
    };
  });
}

/**
 * Downloads a signed storage URL that Orgo handed back. Sends no Orgo
 * credentials: the URL is its own capability, and its host is not Orgo's.
 * The URL never appears in errors.
 */
export async function downloadSigned(
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
  fetchFn: FetchFn = fetch,
): Promise<ArrayBuffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw orgoError("invalid_response", "Orgo returned a download link that is not a URL.");
  }
  if (parsed.protocol !== "https:") {
    throw orgoError("invalid_response", "Orgo returned a download link that is not https.");
  }
  return await exchange(opts.timeoutMs, async (signal) => {
    const res = await fetchFn(parsed.href, { method: "GET", signal, redirect: "follow" });
    if (!res.ok) {
      discard(res.body);
      throw orgoError(
        res.status === 404 || res.status === 403 ? "not_found" : "unavailable",
        `The file download failed (HTTP ${res.status}).`,
        { status: res.status },
      );
    }
    return toArrayBuffer(await readBounded(res, opts.maxBytes, signal));
  });
}

async function send(
  config: OrgoConfig,
  req: OrgoRequest,
  fetchFn: FetchFn,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  if (!req.path.startsWith("/")) throw new Error("path must start with /");
  const url = new URL(`${config.origin}/api${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: accept,
  };
  let body: BodyInit | undefined;
  if (req.form) {
    body = req.form; // fetch sets the multipart boundary
  } else if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  const res = await fetchFn(url.href, { method: req.method, headers, body, signal });
  if (!res.ok) throw await errorFromResponse(res, config.apiKey, signal);
  return res;
}

/**
 * Runs one HTTP exchange under one deadline: the request and reading its
 * body. Any failure leaves as an OrgoError: the deadline as `timeout`,
 * anything else that is not already one as `network`.
 */
async function exchange<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (e) {
    // Orgo answered with an HTTP error: keep it, even if its body was cut short.
    if (isOrgoError(e) && e.data.status !== undefined) throw e;
    if (controller.signal.aborted) {
      throw orgoError(
        "timeout",
        `Orgo did not answer within ${Math.round(timeoutMs / 1000)} s. The request may still have taken effect.`,
      );
    }
    if (isOrgoError(e)) throw e;
    throw orgoError(
      "network",
      "Could not reach Orgo, or its answer was cut off. The request may still have taken effect.",
    );
  } finally {
    clearTimeout(timer);
  }
}

const STATUS_CODES: Record<number, OrgoErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  422: "unprocessable",
  429: "rate_limited",
  501: "not_implemented",
  502: "unavailable",
  503: "unavailable",
  504: "unavailable",
};

async function errorFromResponse(res: Response, apiKey: string, signal: AbortSignal) {
  const status = res.status;
  const code = STATUS_CODES[status] ?? (status >= 500 ? "server_error" : "bad_request");
  let body: unknown = null;
  try {
    const bytes = await readBounded(res, MAX_ERROR_BODY_BYTES, signal);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not JSON (a proxy's HTML page) or too long: keep only the status.
  }
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const message =
    (typeof fields.error === "string" && sanitizeMessage(fields.error, apiKey)) ||
    `Orgo answered HTTP ${status}.`;
  const orgoCode = safeCode(fields.code, apiKey);
  return orgoError(code, message, {
    status,
    orgoCode,
    retryAfterSeconds: retryAfter(res.headers.get("retry-after"), fields.retry_after),
  });
}

function retryAfter(header: string | null, field: unknown): number | undefined {
  const n = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : field;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 86_400 ? n : undefined;
}

/** A run of 20+ letters and digits mixing both: shaped like a key or token. */
const TOKEN_LIKE = /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,}/g;

/**
 * Orgo's error code when it is a plain identifier such as `not_stoppable`;
 * undefined when it is anything else, including something key-shaped.
 */
export function safeCode(code: unknown, apiKey?: string): string | undefined {
  if (typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code)) return undefined;
  if (
    (apiKey && code.includes(apiKey)) ||
    /sk_/i.test(code) ||
    new RegExp(TOKEN_LIKE.source).test(code)
  ) {
    return undefined;
  }
  return code;
}

/** Orgo's message, made safe to show and store: no URLs, no key, bounded. */
export function sanitizeMessage(message: string, apiKey?: string): string {
  let s = message;
  if (apiKey) s = s.split(apiKey).join("[redacted]");
  s = s
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\bsk_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(TOKEN_LIKE, "[redacted]")
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return truncate(s, MAX_MESSAGE_CHARS).text;
}

/**
 * Reads a body, refusing to buffer more than `max` bytes, and giving up
 * when `signal` aborts even if the body stalls.
 */
export async function readBounded(
  res: Response,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    discard(res.body);
    throw tooLarge(max);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => {}); // settled by the race below, or never needed
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooLarge(max);
      chunks.push(value);
    }
  } catch (e) {
    discard(reader);
    throw e;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Cancels a body without waiting: a cancel that never settles must not hold
 * the caller past its deadline.
 */
function discard(body: { cancel(): Promise<void> } | null | undefined) {
  body?.cancel().catch(() => {});
}

function tooLarge(max: number) {
  return orgoError("too_large", `Orgo's response is larger than the ${formatBytes(max)} limit.`);
}

export function formatBytes(n: number): string {
  return n >= MIB ? `${Math.round((n / MIB) * 10) / 10} MiB` : `${Math.round(n / 1024)} KiB`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Cuts a string to `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let cut = max;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: s.slice(0, cut), truncated: true };
}

/** A list size: a whole number from 1 to `max`, `fallback` when absent or not a number. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || Number.isNaN(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Orgo ids are UUIDs: checked before one goes into a URL path, and
 * lowercased so a row is found however the caller spelled it.
 */
export function orgoId(id: string, what: string): string {
  if (!UUID_RE.test(id)) {
    throw orgoError("invalid_argument", `${what} must be an Orgo id (a UUID).`);
  }
  return id.toLowerCase();
}
