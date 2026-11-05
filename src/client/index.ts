/**
 * Host-facing client for the Orgo component.
 *
 * Create it once with the installed component and call its methods from your
 * app's queries, mutations and actions:
 *
 * ```ts
 * import { Orgo } from "orgo-convex";
 * import { components } from "./_generated/api";
 * const orgo = new Orgo(components.orgo);
 * ```
 *
 * The Orgo API key never passes through these calls: the component reads it
 * from the env your convex.config.ts passes down (see README).
 */
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { OrgoErrorCode, OrgoErrorData } from "../component/orgoApi.js";

export type { OrgoErrorCode, OrgoErrorData };

// Public shapes, as they cross the component boundary (ids are strings).
type Api = ComponentApi;
/** A computer as last observed. */
export type Computer = NonNullable<FunctionReturnType<Api["computers"]["get"]>>;
/** What startComputer and stopComputer resolve with. */
export type LifecycleResult = FunctionReturnType<Api["computers"]["start"]>;
/** What runCommand and runPython resolve with. */
export type RunResult = FunctionReturnType<Api["executions"]["run"]>;
/** One execution row. */
export type Execution = NonNullable<FunctionReturnType<Api["executions"]["get"]>>;
/** A screenshot: PNG bytes and their size in pixels. */
export type Screenshot = FunctionReturnType<Api["files"]["screenshot"]>;
/** A file read with exportFile. */
export type ExportedFile = FunctionReturnType<Api["files"]["exportFile"]>;

/** Copies a view into an ArrayBuffer of exactly its length. */
function exactBuffer(content: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (typeof content === "string") return exactBuffer(new TextEncoder().encode(content));
  if (content instanceof Uint8Array) return new Uint8Array(content).buffer as ArrayBuffer;
  return content;
}

/** Read the structured data of an error thrown by this component, if it is one. */
export function orgoErrorData(error: unknown): OrgoErrorData | null {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "OrgoError"
    ? (data as OrgoErrorData)
    : null;
}

// Minimal ctx shapes, so every method accepts any host ctx that can run the
// kind of component function it needs.
export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: Query["_args"],
  ) => Promise<FunctionReturnType<Query>>;
};
export type RunMutationCtx = RunQueryCtx & {
  runMutation: <Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: Mutation["_args"],
  ) => Promise<FunctionReturnType<Mutation>>;
};
export type RunActionCtx = RunMutationCtx & {
  runAction: <Action extends FunctionReference<"action", "internal">>(
    action: Action,
    args: Action["_args"],
  ) => Promise<FunctionReturnType<Action>>;
};

/**
 * Every by-id call takes the `userKey` the computer was created with. Derive
 * it from the signed-in user on the server (never from client input): it is
 * what keeps one user's computers away from another's.
 */
export interface Owned {
  computerId: string;
  userKey?: string;
}

export interface CreateComputerArgs {
  /** Orgo workspace to create the computer in. */
  workspaceId: string;
  /** Display name, 1 to 80 characters. */
  name: string;
  os?: "linux" | "windows";
  /** vCPUs (Orgo accepts 0.5, 1, 2, 4, 6, 8, 16). */
  cpu?: number;
  /** RAM in GB. */
  ram?: number;
  diskSizeGb?: number;
  /** Screen size, e.g. "1280x720x24". */
  resolution?: string;
  /** Orgo template to boot from. */
  templateRef?: string;
  /** Owner key; see `Owned`. */
  userKey?: string;
}

export interface RunArgs extends Owned {
  /** 1 to 300 seconds (Orgo's ceiling), default 60. */
  timeoutSeconds?: number;
}

export interface LifecycleArgs extends Owned {
  /** How long to wait for Orgo to finish, 0 to 300 seconds (default 120). */
  waitSeconds?: number;
}

export interface OrgoOptions {
  /**
   * Allow `deleteComputer`. Off by default so a stray call cannot destroy a
   * computer. Accident prevention, not a security boundary.
   */
  allowDelete?: boolean;
  /**
   * Store the command or code and its output on each execution row
   * (truncated). Off by default: output can hold secrets, and truncation is
   * not redaction. The action's return value always carries the output.
   */
  retainOutput?: boolean;
}

export class Orgo {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: OrgoOptions = {},
  ) {}

  // ---- Computers ----

  /** Create a computer in Orgo and start tracking it. Returns when Orgo answers (it boots running). */
  async createComputer(ctx: RunActionCtx, args: CreateComputerArgs): Promise<Computer> {
    return await ctx.runAction(this.component.computers.create, args);
  }

  /** Last observed state of a computer, or null if `userKey` does not own it. Reactive; no Orgo call. */
  async getComputer(ctx: RunQueryCtx, args: Owned): Promise<Computer | null> {
    return await ctx.runQuery(this.component.computers.get, args);
  }

  /** Live computers of one `userKey`, newest first (default 50, at most 200). Reactive; no Orgo call. */
  async listComputers(
    ctx: RunQueryCtx,
    args: { userKey?: string; limit?: number } = {},
  ): Promise<Computer[]> {
    return await ctx.runQuery(this.component.computers.list, args);
  }

  /** Re-read a computer from Orgo into the table. Null once Orgo says it is gone. */
  async refreshComputer(ctx: RunActionCtx, args: Owned): Promise<Computer | null> {
    return await ctx.runAction(this.component.computers.refresh, args);
  }

  /**
   * Start a stopped computer. Waits up to `waitSeconds` for Orgo to finish;
   * if it is still working, returns `pending: true` (call refreshComputer later).
   */
  async startComputer(ctx: RunActionCtx, args: LifecycleArgs): Promise<LifecycleResult> {
    return await ctx.runAction(this.component.computers.start, args);
  }

  /** Stop a running computer (Orgo keeps its disk; status becomes "frozen"). Same waiting as startComputer. */
  async stopComputer(ctx: RunActionCtx, args: LifecycleArgs): Promise<LifecycleResult> {
    return await ctx.runAction(this.component.computers.stop, args);
  }

  /** Delete a computer in Orgo. Throws `delete_not_allowed` unless the client has `allowDelete: true`. */
  async deleteComputer(ctx: RunActionCtx, args: Owned): Promise<{ deleted: true }> {
    return await ctx.runAction(this.component.computers.remove, {
      ...args,
      allowDelete: this.options.allowDelete === true,
    });
  }

  // ---- Commands ----

  /**
   * Run a shell command and wait for it (bash on Linux, PowerShell on
   * Windows). Resolves for any exit: check `status` and `exitCode`. Throws
   * when Orgo refuses the request, or when the response is lost (the
   * command may still have run; the execution row says `unknown`).
   */
  async runCommand(ctx: RunActionCtx, args: RunArgs & { command: string }): Promise<RunResult> {
    const { command, ...rest } = args;
    return await ctx.runAction(this.component.executions.run, {
      ...rest,
      kind: "command",
      input: command,
      retainOutput: this.options.retainOutput === true,
    });
  }

  /** Run Python code in a fresh interpreter (`python3 -c` on Linux). Same results as runCommand. */
  async runPython(ctx: RunActionCtx, args: RunArgs & { code: string }): Promise<RunResult> {
    const { code, ...rest } = args;
    return await ctx.runAction(this.component.executions.run, {
      ...rest,
      kind: "python",
      input: code,
      retainOutput: this.options.retainOutput === true,
    });
  }

  /** One execution, or null if `userKey` does not own it. Reactive. */
  async getExecution(
    ctx: RunQueryCtx,
    args: { executionId: string; userKey?: string },
  ): Promise<Execution | null> {
    return await ctx.runQuery(this.component.executions.get, args);
  }

  /** Executions on one computer, newest first (default 50, at most 100). Reactive. */
  async listExecutions(ctx: RunQueryCtx, args: Owned & { limit?: number }): Promise<Execution[]> {
    return await ctx.runQuery(this.component.executions.list, args);
  }

  // ---- Screen and files ----

  /**
   * Capture the screen as a PNG (at most 10 MiB). To keep it, store it:
   * `await ctx.storage.store(new Blob([shot.bytes], { type: shot.mimeType }))`.
   */
  async screenshot(ctx: RunActionCtx, args: Owned): Promise<Screenshot> {
    return await ctx.runAction(this.component.files.screenshot, args);
  }

  /**
   * Write a file to an absolute path on the computer, e.g. "/tmp/data.csv"
   * (Linux creates missing folders). A string is written as UTF-8. At most
   * 10 MiB, Orgo's limit.
   */
  async uploadFile(
    ctx: RunActionCtx,
    args: Owned & { path: string; content: string | ArrayBuffer | Uint8Array },
  ): Promise<{ path: string; placedIn: string; sizeBytes: number }> {
    return await ctx.runAction(this.component.files.upload, {
      ...args,
      content: exactBuffer(args.content),
    });
  }

  /**
   * Read a file from an absolute path on the computer. `maxBytes` defaults
   * to 10 MiB and can go up to 12 MiB (Convex's return limit is 16 MiB).
   * Decode text with `new TextDecoder().decode(file.bytes)`.
   */
  async exportFile(
    ctx: RunActionCtx,
    args: Owned & { path: string; maxBytes?: number },
  ): Promise<ExportedFile> {
    return await ctx.runAction(this.component.files.exportFile, args);
  }

  /**
   * Operator maintenance: deletes EVERY owner's executions older than
   * `olderThanMs`, 100 per call, keeping runs still in progress; call again
   * while `hasMore`. Call it from an internal function or cron, never from
   * a function your users can reach.
   */
  async purgeExecutions(
    ctx: RunMutationCtx,
    args: { olderThanMs: number },
  ): Promise<{ deleted: number; hasMore: boolean }> {
    return await ctx.runMutation(this.component.executions.purge, args);
  }
}

export type { ComponentApi };
