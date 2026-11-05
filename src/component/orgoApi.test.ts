import { describe, expect, test, vi } from "vitest";
import {
  clampLimit,
  DEFAULT_ORGO_API_URL,
  downloadSigned,
  isOrgoError,
  orgoId,
  orgoBytes,
  orgoJson,
  resolveConfig,
  sanitizeMessage,
  truncate,
  type FetchFn,
  type OrgoConfig,
} from "./orgoApi.js";
import { COMPUTER_ID, SECRET, SENTINELS } from "../fixtures/orgo.js";

const config: OrgoConfig = { apiKey: SECRET.apiKey, origin: "https://orgo.example" };

type Call = { url: string; init: RequestInit };

/** A fetch that records each call and answers with the given responses in order. */
function fakeFetch(...responses: Array<Response | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fn as unknown as FetchFn, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isOrgoError(e)) return e.data;
    throw e;
  }
  throw new Error("expected an OrgoError");
}

describe("resolveConfig", () => {
  test("defaults the origin and keeps the key", () => {
    expect(resolveConfig({ ORGO_API_KEY: "k" })).toEqual({
      apiKey: "k",
      origin: DEFAULT_ORGO_API_URL,
    });
  });

  test("a missing key is a config error that names the fix", () => {
    for (const env of [{}, { ORGO_API_KEY: "  " }]) {
      try {
        resolveConfig(env);
        throw new Error("no throw");
      } catch (e) {
        expect(isOrgoError(e) && e.data.code).toBe("config");
        expect(isOrgoError(e) && e.data.message).toContain("app.use(orgo");
      }
    }
  });

  test.each([
    ["https://orgo.example.com", "https://orgo.example.com"],
    ["https://orgo.example.com/", "https://orgo.example.com"],
    ["  https://www.orgo.ai  ", "https://www.orgo.ai"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("origin %s → %s", (raw, origin) => {
    expect(resolveConfig({ ORGO_API_KEY: "k", ORGO_API_URL: raw }).origin).toBe(origin);
  });

  test.each([
    "https://www.orgo.ai/api",
    "https://www.orgo.ai/api/",
    "http://www.orgo.ai",
    "https://user:pw@www.orgo.ai",
    "https://www.orgo.ai?x=1",
    "www.orgo.ai",
  ])("rejects %s", (raw) => {
    try {
      resolveConfig({ ORGO_API_KEY: "k", ORGO_API_URL: raw });
      throw new Error("no throw");
    } catch (e) {
      expect(isOrgoError(e) && e.data.code).toBe("config");
    }
  });
});

describe("orgoJson", () => {
  test("sends method, URL with one /api prefix, bearer key and the exact JSON body", async () => {
    const { fetch, calls } = fakeFetch(json({ ok: 1 }, 201));
    const res = await orgoJson(
      config,
      {
        method: "POST",
        path: "/computers",
        json: { name: "a", workspace_id: "w" },
        timeoutMs: 1000,
      },
      fetch,
    );
    expect(res).toEqual({ status: 201, body: { ok: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://orgo.example/api/computers");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET.apiKey}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.body).toBe('{"name":"a","workspace_id":"w"}');
  });

  test("an empty success body reads as null", async () => {
    for (const status of [200, 204]) {
      const { fetch } = fakeFetch(new Response(null, { status }));
      const res = await orgoJson(config, { method: "DELETE", path: "/x", timeoutMs: 1000 }, fetch);
      expect(res).toEqual({ status, body: null });
    }
  });

  test("adds query parameters", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await orgoJson(
      config,
      { method: "GET", path: "/x", query: { a: "1 2" }, timeoutMs: 1000 },
      fetch,
    );
    expect(calls[0].url).toBe("https://orgo.example/api/x?a=1+2");
  });

  test("401 maps to unauthorized and never echoes the key", async () => {
    const { fetch } = fakeFetch(json({ error: `Invalid key ${SECRET.apiKey}` }, 401));
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(JSON.stringify(err)).not.toContain(SECRET.apiKey);
  });

  test("redacts a key of any shape that an error message echoes", async () => {
    const plain = { ...config, apiKey: "plain-key-0123456789" };
    const { fetch } = fakeFetch(json({ error: "bad key plain-key-0123456789" }, 401));
    const err = await caught(
      orgoJson(plain, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.message).toBe("bad key [redacted]");
  });

  test("keeps only Orgo's error, code and retry hint, never the rest of the body", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          error: `Slow down, see ${SECRET.signedUrl}`,
          code: "rate_limited_by_plan",
          vnc_password: SECRET.vncPassword,
          upstream_status: 500,
        },
        429,
        { "retry-after": "7" },
      ),
    );
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err).toEqual({
      kind: "OrgoError",
      code: "rate_limited",
      status: 429,
      message: "Slow down, see [url]",
      orgoCode: "rate_limited_by_plan",
      retryAfterSeconds: 7,
    });
    for (const s of SENTINELS) expect(JSON.stringify(err)).not.toContain(s);
  });

  test.each([
    [400, "bad_request"],
    [402, "payment_required"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "too_large"],
    [422, "unprocessable"],
    [501, "not_implemented"],
    [503, "unavailable"],
    [500, "server_error"],
    [418, "bad_request"],
  ])("HTTP %i → %s", async (status, code) => {
    const { fetch } = fakeFetch(json({ error: "x" }, status));
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.code).toBe(code);
  });

  test("a non-JSON error page keeps only the status", async () => {
    const { fetch } = fakeFetch(
      new Response("<html>Bad gateway at https://internal.example</html>", { status: 502 }),
    );
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err).toEqual({
      kind: "OrgoError",
      code: "unavailable",
      status: 502,
      message: "Orgo answered HTTP 502.",
    });
  });

  test.each([
    ["the configured key", "plain-key-0123456789"],
    ["an sk_ key", "sk_live_abcdefghijkl"],
    ["a token-shaped string", "a1b2c3d4e5f6a7b8c9d0e1f2"],
  ])("an orgoCode that is %s is dropped", async (_, code) => {
    const plain = { ...config, apiKey: "plain-key-0123456789" };
    const { fetch } = fakeFetch(json({ error: "x", code }, 500));
    const err = await caught(
      orgoJson(plain, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.orgoCode).toBeUndefined();
  });

  test("real Orgo codes pass", async () => {
    for (const code of [
      "not_stoppable",
      "ALLOCATION_MANAGED",
      "TRIAL_ARCHIVE_UNAVAILABLE",
      "workspace_read_only",
    ]) {
      const { fetch } = fakeFetch(json({ error: "x", code }, 409));
      const err = await caught(
        orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
      );
      expect(err.orgoCode).toBe(code);
    }
  });

  test("an orgoCode that is not a plain token is dropped", async () => {
    const { fetch } = fakeFetch(json({ error: "x", code: "<script>" }, 409));
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.orgoCode).toBeUndefined();
  });

  test("malformed JSON on a 2xx is invalid_response", async () => {
    const { fetch } = fakeFetch(new Response("{not json", { status: 200 }));
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.code).toBe("invalid_response");
  });

  test("a deadline aborts the request and says the outcome is unknown", async () => {
    const fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as FetchFn;
    const err = await caught(orgoJson(config, { method: "GET", path: "/x", timeoutMs: 20 }, fetch));
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("may still have taken effect");
  });

  function stalled(status: number, head = "") {
    // Headers now, then the body never finishes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head) controller.enqueue(new TextEncoder().encode(head));
      },
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }

  test("the deadline covers the body: headers then a stalled body times out", async () => {
    const { fetch } = fakeFetch(stalled(200, '{"ok":'));
    const started = Date.now();
    const err = await caught(orgoJson(config, { method: "GET", path: "/x", timeoutMs: 50 }, fetch));
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a stalled error body still ends at the deadline, keeping the status", async () => {
    const { fetch } = fakeFetch(stalled(503, '{"error":'));
    const started = Date.now();
    const err = await caught(orgoJson(config, { method: "GET", path: "/x", timeoutMs: 50 }, fetch));
    expect(err).toMatchObject({ code: "unavailable", status: 503 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a cancel that never settles does not hold the caller past the deadline", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
      },
      cancel() {
        cancelled += 1;
        return new Promise<void>(() => {});
      },
    });
    const { fetch } = fakeFetch(new Response(body, { status: 200 }));
    const started = Date.now();
    const err = await caught(orgoJson(config, { method: "GET", path: "/x", timeoutMs: 50 }, fetch));
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancelled).toBe(1);
  });

  test("a body that errors mid-stream is a network OrgoError", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`socket closed ${SECRET.apiKey}`));
      },
    });
    const { fetch } = fakeFetch(new Response(body, { status: 200 }));
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.code).toBe("network");
    expect(JSON.stringify(err)).not.toContain(SECRET.apiKey);
  });

  test("the signed download is bounded by the same deadline", async () => {
    const { fetch } = fakeFetch(stalled(200, "partial"));
    const err = await caught(
      downloadSigned(SECRET.signedUrl, { timeoutMs: 50, maxBytes: 100 }, fetch),
    );
    expect(err.code).toBe("timeout");
  });

  test("a network failure is network, without the URL", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed: https://orgo.example/api/x");
    }) as unknown as FetchFn;
    const err = await caught(
      orgoJson(config, { method: "GET", path: "/x", timeoutMs: 1000 }, fetch),
    );
    expect(err.code).toBe("network");
    expect(err.message).not.toContain("orgo.example");
  });

  test("refuses a body over the cap by Content-Length", async () => {
    const { fetch } = fakeFetch(
      new Response("x".repeat(10), { status: 200, headers: { "content-length": "5000" } }),
    );
    const err = await caught(
      orgoJson(
        config,
        { method: "GET", path: "/x", timeoutMs: 1000, maxResponseBytes: 100 },
        fetch,
      ),
    );
    expect(err.code).toBe("too_large");
  });

  test("refuses a streamed body over the cap without Content-Length", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 2000) return controller.close();
        sent += 64;
        controller.enqueue(new Uint8Array(64));
      },
    });
    const { fetch } = fakeFetch(new Response(stream, { status: 200 }));
    const err = await caught(
      orgoJson(
        config,
        { method: "GET", path: "/x", timeoutMs: 1000, maxResponseBytes: 1000 },
        fetch,
      ),
    );
    expect(err.code).toBe("too_large");
  });
});

describe("orgoBytes", () => {
  test("returns the exact bytes and content type", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { fetch, calls } = fakeFetch(
      new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const res = await orgoBytes(config, { method: "GET", path: "/s", timeoutMs: 1000 }, fetch);
    expect(new Uint8Array(res.bytes)).toEqual(png);
    expect(res.contentType).toBe("image/png");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET.apiKey}`,
    );
  });
});

describe("downloadSigned", () => {
  test("sends no Orgo credentials", async () => {
    const { fetch, calls } = fakeFetch(new Response("hello", { status: 200 }));
    const bytes = await downloadSigned(SECRET.signedUrl, { timeoutMs: 1000, maxBytes: 100 }, fetch);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(calls[0].init.headers).toBeUndefined();
    expect(JSON.stringify(calls[0].init)).not.toContain(SECRET.apiKey);
  });

  test("refuses a non-https link", async () => {
    const { fetch, calls } = fakeFetch();
    const err = await caught(
      downloadSigned("http://objects.example.com/x", { timeoutMs: 1000, maxBytes: 100 }, fetch),
    );
    expect(err.code).toBe("invalid_response");
    expect(calls).toHaveLength(0);
  });

  test("a failed download never names the signed URL", async () => {
    const { fetch } = fakeFetch(new Response("denied", { status: 403 }));
    const err = await caught(
      downloadSigned(SECRET.signedUrl, { timeoutMs: 1000, maxBytes: 100 }, fetch),
    );
    for (const s of SENTINELS) expect(JSON.stringify(err)).not.toContain(s);
  });

  test("stops at the byte cap", async () => {
    const { fetch } = fakeFetch(new Response("x".repeat(200), { status: 200 }));
    const err = await caught(
      downloadSigned(SECRET.signedUrl, { timeoutMs: 1000, maxBytes: 100 }, fetch),
    );
    expect(err.code).toBe("too_large");
  });
});

describe("helpers", () => {
  test("clampLimit bounds a list size and ignores a value that is not a number", () => {
    expect(clampLimit(undefined, 50, 200)).toBe(50);
    expect(clampLimit(Number.NaN, 50, 200)).toBe(50);
    expect(clampLimit(7.9, 50, 200)).toBe(7);
    expect(clampLimit(0, 50, 200)).toBe(1);
    expect(clampLimit(-Infinity, 50, 200)).toBe(1);
    expect(clampLimit(Infinity, 50, 200)).toBe(200);
  });

  test("sanitizeMessage strips URLs, keys and control characters and bounds length", () => {
    expect(sanitizeMessage(`a\nb ${SECRET.signedUrl} sk_live_abcdefghijkl`, SECRET.apiKey)).toBe(
      "a b [url] [redacted]",
    );
    expect(sanitizeMessage("x".repeat(1000)).length).toBe(300);
  });

  test("truncate never splits a surrogate pair", () => {
    expect(truncate("ab😀", 3)).toEqual({ text: "ab", truncated: true });
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  test("ids must be UUIDs before they go into a path", () => {
    expect(orgoId(COMPUTER_ID.toUpperCase(), "computerId")).toBe(COMPUTER_ID);
    for (const bad of ["../files", "", `${COMPUTER_ID}/stop`, "abc"]) {
      try {
        orgoId(bad, "computerId");
        throw new Error("no throw");
      } catch (e) {
        expect(isOrgoError(e) && e.data.code).toBe("invalid_argument");
      }
    }
  });
});
