// Internal functions that scripts/live-test.mjs drives with `npx convex run`
// against a real Orgo workspace. Internal: no browser can call them.
import { v } from "convex/values";
import { Orgo, orgoErrorData } from "orgo-convex";
import { components } from "./_generated/api.js";
import { internalAction, internalQuery } from "./_generated/server.js";

const orgo = new Orgo(components.orgo);
const orgoWithDelete = new Orgo(components.orgo, { allowDelete: true });

const owned = { computerId: v.string(), userKey: v.optional(v.string()) };

export const create = internalAction({
  args: { workspaceId: v.string(), name: v.string(), userKey: v.optional(v.string()) },
  handler: async (ctx, args) => orgo.createComputer(ctx, args),
});

export const get = internalQuery({
  args: owned,
  handler: async (ctx, args) => orgo.getComputer(ctx, args),
});

export const list = internalQuery({
  args: { userKey: v.optional(v.string()) },
  handler: async (ctx, args) => orgo.listComputers(ctx, args),
});

export const refresh = internalAction({
  args: owned,
  handler: async (ctx, args) => orgo.refreshComputer(ctx, args),
});

export const stop = internalAction({
  args: { ...owned, waitSeconds: v.optional(v.number()) },
  handler: async (ctx, args) => orgo.stopComputer(ctx, args),
});

export const start = internalAction({
  args: { ...owned, waitSeconds: v.optional(v.number()) },
  handler: async (ctx, args) => orgo.startComputer(ctx, args),
});

/** Uses the default client: must be refused. */
export const deleteDefault = internalAction({
  args: owned,
  handler: async (ctx, args) => orgo.deleteComputer(ctx, args),
});

export const deleteAllowed = internalAction({
  args: owned,
  handler: async (ctx, args) => orgoWithDelete.deleteComputer(ctx, args),
});

const orgoRetaining = new Orgo(components.orgo, { retainOutput: true });

export const runCommand = internalAction({
  args: {
    ...owned,
    command: v.string(),
    timeoutSeconds: v.optional(v.number()),
    retain: v.optional(v.boolean()),
  },
  handler: async (ctx, { retain, ...args }) =>
    (retain ? orgoRetaining : orgo).runCommand(ctx, args),
});

export const runPython = internalAction({
  args: { ...owned, code: v.string(), timeoutSeconds: v.optional(v.number()) },
  handler: async (ctx, args) => orgo.runPython(ctx, args),
});

export const listExecutions = internalQuery({
  args: owned,
  handler: async (ctx, args) => orgo.listExecutions(ctx, args),
});

async function sha256(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic pseudo-random bytes (xorshift32), every value 0-255 appears. */
function pattern(size: number) {
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

export const screenshotInfo = internalAction({
  args: owned,
  handler: async (ctx, args) => {
    const shot = await orgo.screenshot(ctx, args);
    const head = new Uint8Array(shot.bytes.slice(0, 8));
    return {
      byteLength: shot.bytes.byteLength,
      mimeType: shot.mimeType,
      width: shot.width,
      height: shot.height,
      magic: Array.from(head, (b) => b.toString(16).padStart(2, "0")).join(" "),
      sha256: await sha256(shot.bytes),
    };
  },
});

export const uploadText = internalAction({
  args: { ...owned, path: v.string(), text: v.string() },
  handler: async (ctx, { text, ...args }) => orgo.uploadFile(ctx, { ...args, content: text }),
});

export const uploadPattern = internalAction({
  args: { ...owned, path: v.string(), size: v.number() },
  handler: async (ctx, { size, ...args }) => {
    const bytes = pattern(size);
    const placed = await orgo.uploadFile(ctx, { ...args, content: bytes });
    return { ...placed, sha256: await sha256(bytes.buffer as ArrayBuffer) };
  },
});

export const exportInfo = internalAction({
  args: { ...owned, path: v.string(), maxBytes: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const file = await orgo.exportFile(ctx, args);
    return {
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      filename: file.filename,
      sha256: await sha256(file.bytes),
      text: new TextDecoder().decode(file.bytes.slice(0, 200)),
    };
  },
});

/** Calls a file method expected to fail and returns its error code. */
export const expectFailure = internalAction({
  args: {
    ...owned,
    what: v.union(v.literal("oversizeUpload"), v.literal("exportTooBig")),
    path: v.string(),
  },
  handler: async (ctx, { what, ...args }) => {
    try {
      if (what === "oversizeUpload") {
        await orgo.uploadFile(ctx, { ...args, content: new Uint8Array(10 * 1024 * 1024 + 1) });
      } else {
        await orgo.exportFile(ctx, { ...args, maxBytes: 1024 });
      }
      return "no error";
    } catch (e) {
      return orgoErrorData(e) ?? String(e);
    }
  },
});
