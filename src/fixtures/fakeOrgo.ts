// Shared test helpers: a fake Orgo for convex-test runs. Lives in
// src/fixtures, which never ships or deploys.
import { vi } from "vitest";
import { SECRET } from "./orgo.js";

export interface RecordedCall {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Installs a fake fetch that answers Orgo routes by "METHOD /path" (path
 * after /api). Each route takes a list of answers used in order; the last
 * repeats. Unknown routes fail the test.
 */
export function fakeOrgo(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = [];
  const queues = new Map(
    Object.entries(routes).map(([k, h]) => [k, Array.isArray(h) ? [...h] : [h]]),
  );
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    const path = url.pathname.replace(/^\/api/, "");
    const call = { method: init?.method ?? "GET", path, query: url.search, headers, body };
    calls.push(call);
    const key = `${call.method} ${path}`;
    const queue = queues.get(key) ?? queues.get(`${call.method} ${url.origin}${url.pathname}`);
    if (!queue) throw new Error(`fake Orgo: no route for ${key}`);
    const handler = queue.length > 1 ? queue.shift()! : queue[0];
    return await handler(call);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

export function useOrgoEnv(url = "https://orgo.example") {
  vi.stubEnv("ORGO_API_KEY", SECRET.apiKey);
  vi.stubEnv("ORGO_API_URL", url);
}

export function resetOrgo() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}
