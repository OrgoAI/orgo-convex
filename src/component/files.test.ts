import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import * as fx from "../fixtures/orgo.js";
import { fakeOrgo, json, resetOrgo, useOrgoEnv } from "../fixtures/fakeOrgo.js";
import { splitGuestPath } from "./files.js";

const ID = fx.COMPUTER_ID;
const SIGNED = "GET https://objects.example.com/x";

beforeEach(() => useOrgoEnv());
afterEach(() => resetOrgo());

async function errorData(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: { code?: string } }).data;
    if (data?.code) return data as { code: string; message: string; status?: number };
    throw e;
  }
  throw new Error("expected an error");
}

async function setup(userKey = "u") {
  const t = initConvexTest();
  fakeOrgo({ "POST /computers": () => json(fx.createdComputer, 201) });
  await t.action(api.computers.create, { workspaceId: fx.WORKSPACE_ID, name: "n", userKey });
  return t;
}

function bytesOf(s: string) {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe("screenshot", () => {
  test("asks for binary PNG and returns the exact bytes and size", async () => {
    const t = await setup();
    const png = fx.pngBytes(1280, 720);
    const { calls } = fakeOrgo({
      [`GET /computers/${ID}/screenshot`]: () =>
        new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const shot = await t.action(api.files.screenshot, { computerId: ID, userKey: "u" });
    expect(calls[0].query).toBe("?response_format=binary&format=png");
    expect(new Uint8Array(shot.bytes)).toEqual(png);
    expect(shot).toMatchObject({ mimeType: "image/png", width: 1280, height: 720 });
  });

  test("a body that is not a PNG (e.g. URL mode JSON) is invalid_response", async () => {
    const t = await setup();
    fakeOrgo({
      [`GET /computers/${ID}/screenshot`]: () =>
        json({ success: true, image: "/api/storage/x.png" }),
    });
    expect(
      (await errorData(t.action(api.files.screenshot, { computerId: ID, userKey: "u" }))).code,
    ).toBe("invalid_response");
  });

  test("over 10 MiB is refused", async () => {
    const t = await setup();
    fakeOrgo({
      [`GET /computers/${ID}/screenshot`]: () =>
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200 }),
    });
    expect(
      (await errorData(t.action(api.files.screenshot, { computerId: ID, userKey: "u" }))).code,
    ).toBe("too_large");
  });

  test("another userKey gets not_found with no request", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({});
    expect(
      (await errorData(t.action(api.files.screenshot, { computerId: ID, userKey: "x" }))).code,
    ).toBe("not_found");
    expect(calls).toHaveLength(0);
  });
});

describe("splitGuestPath", () => {
  test.each([
    ["/tmp/x.txt", "/tmp", "x.txt"],
    ["/x.txt", "/", "x.txt"],
    ["/root/My Files/naïve résumé.pdf", "/root/My Files", "naïve résumé.pdf"],
    ["C:\\Users\\Public\\a b.txt", "C:\\Users\\Public", "a b.txt"],
    ["C:/data.csv", "C:\\", "data.csv"],
    ["C:\\data.csv", "C:\\", "data.csv"],
  ])("%s → folder %s, name %s", (path, folder, name) => {
    expect(splitGuestPath(path)).toEqual({ folder, name });
  });

  test.each(["tmp/x.txt", "/tmp/", "/tmp/..", "/tmp/.", "", "/a\0b", "~/x.txt"])(
    "rejects %j",
    (path) => {
      try {
        splitGuestPath(path);
        throw new Error("no throw");
      } catch (e) {
        expect((e as { data?: { code?: string } }).data?.code).toBe("invalid_argument");
      }
    },
  );
});

describe("uploadFile", () => {
  test("sends the file under its own name to the folder, with workspace and computer ids", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({
      "POST /files/upload": () => json({ ok: true, placedIn: "/tmp/a dir" }),
    });
    const res = await t.action(api.files.upload, {
      computerId: ID,
      userKey: "u",
      path: "/tmp/a dir/naïve file.txt",
      content: bytesOf("hello ✓"),
    });
    expect(res).toEqual({
      path: "/tmp/a dir/naïve file.txt",
      placedIn: "/tmp/a dir",
      sizeBytes: 9,
    });
    const form = calls[0].body as FormData;
    expect(form.get("workspaceId")).toBe(fx.WORKSPACE_ID);
    expect(form.get("desktopId")).toBe(ID);
    expect(form.get("destPath")).toBe("/tmp/a dir");
    const file = form.get("file") as File;
    expect(file.name).toBe("naïve file.txt");
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe("hello ✓");
  });

  test("over Orgo's 10 MiB limit is refused before any request", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({});
    const err = await errorData(
      t.action(api.files.upload, {
        computerId: ID,
        userKey: "u",
        path: "/tmp/big.bin",
        content: new ArrayBuffer(10 * 1024 * 1024 + 1),
      }),
    );
    expect(err.code).toBe("too_large");
    expect(calls).toHaveLength(0);
  });

  test("a relative path is refused before any request", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({});
    expect(
      (
        await errorData(
          t.action(api.files.upload, {
            computerId: ID,
            userKey: "u",
            path: "x.txt",
            content: bytesOf("x"),
          }),
        )
      ).code,
    ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  test("Orgo could not place it (502) → unavailable", async () => {
    const t = await setup();
    fakeOrgo({
      "POST /files/upload": () => json({ error: "Could not place x.txt in /tmp." }, 502),
    });
    expect(
      (
        await errorData(
          t.action(api.files.upload, {
            computerId: ID,
            userKey: "u",
            path: "/tmp/x.txt",
            content: bytesOf("x"),
          }),
        )
      ).code,
    ).toBe("unavailable");
  });
});

describe("exportFile", () => {
  test("exports, downloads without credentials, deletes the stored copy, returns exact bytes", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({
      "POST /files/export": () => json(fx.exported),
      [SIGNED]: () => new Response("hello", { status: 200 }),
      "DELETE /files/delete": () => json({ success: true }),
    });
    const file = await t.action(api.files.exportFile, {
      computerId: ID,
      userKey: "u",
      path: "/tmp/x.txt",
    });
    expect(new TextDecoder().decode(file.bytes)).toBe("hello");
    expect(file).toMatchObject({ sizeBytes: 5, contentType: "text/plain", filename: "x.txt" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /files/export",
      "GET /x",
      "DELETE /files/delete",
    ]);
    expect(calls[0].body).toEqual({ desktopId: ID, path: "/tmp/x.txt" });
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(calls[2].query).toBe(`?id=${fx.exported.file.id}`);
    for (const s of fx.SENTINELS) expect(JSON.stringify({ ...file, bytes: null })).not.toContain(s);
  });

  test("a file over maxBytes is refused before downloading, and the copy is still deleted", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({
      "POST /files/export": () =>
        json({ ...fx.exported, file: { ...fx.exported.file, size_bytes: "2048" } }),
      "DELETE /files/delete": () => json({ success: true }),
    });
    const err = await errorData(
      t.action(api.files.exportFile, {
        computerId: ID,
        userKey: "u",
        path: "/tmp/x.txt",
        maxBytes: 1024,
      }),
    );
    expect(err.code).toBe("too_large");
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(JSON.stringify(err)).not.toContain("SENTINEL_signature");
  });

  test("a malformed export answer still deletes the stored copy", async () => {
    const t = await setup();
    const { calls } = fakeOrgo({
      "POST /files/export": () =>
        json({ ...fx.exported, file: { ...fx.exported.file, size_bytes: "big" } }),
      "DELETE /files/delete": () => json({ success: true }),
    });
    const err = await errorData(
      t.action(api.files.exportFile, { computerId: ID, userKey: "u", path: "/tmp/x.txt" }),
    );
    expect(err.code).toBe("invalid_response");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /files/export",
      "DELETE /files/delete",
    ]);
  });

  test("a failed cleanup does not fail the read", async () => {
    const t = await setup();
    fakeOrgo({
      "POST /files/export": () => json(fx.exported),
      [SIGNED]: () => new Response("hello", { status: 200 }),
      "DELETE /files/delete": () => json({ error: "Delete failed" }, 500),
    });
    const file = await t.action(api.files.exportFile, {
      computerId: ID,
      userKey: "u",
      path: "/tmp/x.txt",
    });
    expect(file.sizeBytes).toBe(5);
  });

  test("no record id: nothing to delete", async () => {
    const t = await setup();
    const { id: _id, ...file } = fx.exported.file;
    const { calls } = fakeOrgo({
      "POST /files/export": () => json({ ...fx.exported, file }),
      [SIGNED]: () => new Response("hello", { status: 200 }),
    });
    await t.action(api.files.exportFile, { computerId: ID, userKey: "u", path: "/tmp/x.txt" });
    expect(calls).toHaveLength(2);
  });

  test.each([
    [404, "No file at /tmp/x.txt", "not_found"],
    [400, "Desktop is not running", "bad_request"],
    [413, "File is 3221225472 bytes; the limit is 2147483648.", "too_large"],
  ])("Orgo %i (%s) → %s", async (status, error, code) => {
    const t = await setup();
    fakeOrgo({ "POST /files/export": () => json({ error }, status) });
    const err = await errorData(
      t.action(api.files.exportFile, { computerId: ID, userKey: "u", path: "/tmp/x.txt" }),
    );
    expect(err).toMatchObject({ code, message: error });
  });

  test.each([0, 12 * 1024 * 1024 + 1, 1.5])(
    "maxBytes %d is refused before any request",
    async (maxBytes) => {
      const t = await setup();
      const { calls } = fakeOrgo({});
      expect(
        (
          await errorData(
            t.action(api.files.exportFile, {
              computerId: ID,
              userKey: "u",
              path: "/tmp/x.txt",
              maxBytes,
            }),
          )
        ).code,
      ).toBe("invalid_argument");
      expect(calls).toHaveLength(0);
    },
  );
});
