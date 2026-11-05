// Screenshots and file transfer. Bytes cross the Convex boundary as
// ArrayBuffers, so every path enforces its own cap well under the 16 MiB
// argument/return limit, before buffering where it can.
import { v } from "convex/values";
import { action, env } from "./_generated/server.js";
import { requireOwned } from "./computers.js";
import {
  downloadSigned,
  formatBytes,
  isOrgoError,
  orgoBytes,
  orgoError,
  orgoJson,
  resolveConfig,
  type OrgoConfig,
} from "./orgoApi.js";
import { exportedFileId, parseExport, parseUpload } from "./wire.js";

const MIB = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * MIB;
/** Orgo's direct upload limit. */
export const MAX_UPLOAD_BYTES = 10 * MIB;
const DEFAULT_EXPORT_BYTES = 10 * MIB;
/** Under Convex's 16 MiB return limit, with room for the rest of the result. */
export const MAX_EXPORT_BYTES = 12 * MIB;
const SCREENSHOT_TIMEOUT_MS = 60_000;
/** Orgo pulls an upload onto the computer within 130 s. */
const UPLOAD_TIMEOUT_MS = 150_000;
/** Orgo gives the computer 90 s to push an export. */
const EXPORT_TIMEOUT_MS = 150_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 30_000;

const owned = { computerId: v.string(), userKey: v.optional(v.string()) };

export const screenshotResultValidator = v.object({
  bytes: v.bytes(),
  mimeType: v.literal("image/png"),
  width: v.number(),
  height: v.number(),
});

/** Width and height from a PNG's IHDR chunk, or null if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Captures the computer's screen as a PNG. */
export const screenshot = action({
  args: owned,
  returns: screenshotResultValidator,
  handler: async (ctx, args) => {
    const computer = await requireOwned(ctx, args.computerId, args.userKey);
    const config = resolveConfig(env);
    // Binary mode: the default answers with a link to Orgo's auth-gated storage.
    const res = await orgoBytes(config, {
      method: "GET",
      path: `/computers/${computer.computerId}/screenshot`,
      query: { response_format: "binary", format: "png" },
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
      maxResponseBytes: MAX_SCREENSHOT_BYTES,
    });
    const size = pngSize(new Uint8Array(res.bytes));
    if (!size) throw orgoError("invalid_response", "Orgo's screenshot is not a PNG.");
    return { bytes: res.bytes, mimeType: "image/png" as const, ...size };
  },
});

/**
 * Splits an absolute file path into its folder and file name. Linux paths
 * start with "/", Windows paths with a drive ("C:\" or "C:/").
 */
export function splitGuestPath(path: string): { folder: string; name: string } {
  const bad = (why: string) => orgoError("invalid_argument", `path ${why}.`);
  if (path.includes("\0")) throw bad("contains a NUL character");
  if (path.length > 4096) throw bad("is longer than 4096 characters");
  const windows = /^[a-zA-Z]:[\\/]/.test(path);
  if (!windows && !path.startsWith("/")) throw bad('must be absolute, e.g. "/tmp/report.txt"');
  const cut = windows
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  if (!name.trim() || name === "." || name === "..") throw bad("must end with a file name");
  let folder = path.slice(0, cut);
  if (windows && /^[a-zA-Z]:$/.test(folder)) folder += "\\";
  if (!windows && folder === "") folder = "/";
  return { folder, name };
}

/**
 * Writes bytes to an absolute path on the computer (folders are created on
 * Linux). Orgo places the file directly; nothing is kept in Orgo's
 * workspace storage.
 */
export const upload = action({
  args: { ...owned, path: v.string(), content: v.bytes() },
  returns: v.object({ path: v.string(), placedIn: v.string(), sizeBytes: v.number() }),
  handler: async (ctx, args) => {
    const { folder, name } = splitGuestPath(args.path);
    if (args.content.byteLength > MAX_UPLOAD_BYTES) {
      throw orgoError(
        "too_large",
        `The file is larger than Orgo's ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`,
      );
    }
    const computer = await requireOwned(ctx, args.computerId, args.userKey);
    const config = resolveConfig(env);
    const form = new FormData();
    form.append("file", new Blob([args.content]), name);
    form.append("workspaceId", computer.workspaceId);
    form.append("desktopId", computer.computerId);
    // A folder, not the file's path: Orgo appends the file name itself.
    form.append("destPath", folder);
    const res = await orgoJson(config, {
      method: "POST",
      path: "/files/upload",
      form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const { placedIn } = parseUpload(res.body);
    return { path: args.path, placedIn, sizeBytes: args.content.byteLength };
  },
});

async function deleteExportRecord(config: OrgoConfig, fileId: string | undefined) {
  if (!fileId) return;
  try {
    await orgoJson(config, {
      method: "DELETE",
      path: "/files/delete",
      query: { id: fileId },
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Best effort: if this fails, one copy stays in the workspace's Files
    // list until someone deletes it.
  }
}

/**
 * Reads a file from the computer. Orgo copies it to workspace storage and
 * returns a one-hour link; the component downloads it (no Orgo credentials
 * on that request) and then deletes the stored copy, so nothing is left in
 * the workspace's Files list.
 */
export const exportFile = action({
  args: { ...owned, path: v.string(), maxBytes: v.optional(v.number()) },
  returns: v.object({
    bytes: v.bytes(),
    sizeBytes: v.number(),
    contentType: v.optional(v.string()),
    filename: v.string(),
  }),
  handler: async (ctx, args) => {
    const { name } = splitGuestPath(args.path);
    const maxBytes = args.maxBytes ?? DEFAULT_EXPORT_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXPORT_BYTES) {
      throw orgoError(
        "invalid_argument",
        `maxBytes must be a whole number from 1 to ${MAX_EXPORT_BYTES}.`,
      );
    }
    const computer = await requireOwned(ctx, args.computerId, args.userKey);
    const config = resolveConfig(env);
    const res = await orgoJson(config, {
      method: "POST",
      path: "/files/export",
      json: { desktopId: computer.computerId, path: args.path },
      timeoutMs: EXPORT_TIMEOUT_MS,
    });
    const fileId = exportedFileId(res.body);
    try {
      const exported = parseExport(res.body);
      if (exported.sizeBytes > maxBytes) {
        throw orgoError(
          "too_large",
          `${name} is ${exported.sizeBytes} bytes, over the ${maxBytes}-byte limit for exportFile.`,
        );
      }
      const bytes = await downloadSigned(exported.url, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes,
      });
      return {
        bytes,
        sizeBytes: bytes.byteLength,
        ...(exported.contentType ? { contentType: exported.contentType } : {}),
        filename: name,
      };
    } catch (e) {
      if (isOrgoError(e)) throw e;
      throw orgoError("network", "The file download failed.");
    } finally {
      await deleteExportRecord(config, fileId);
    }
  },
});
