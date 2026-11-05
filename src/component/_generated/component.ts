/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    computers: {
      create: FunctionReference<
        "action",
        "internal",
        {
          cpu?: number;
          diskSizeGb?: number;
          name: string;
          os?: "linux" | "windows";
          ram?: number;
          resolution?: string;
          templateRef?: string;
          userKey?: string;
          workspaceId: string;
        },
        {
          computerId: string;
          deletedAt?: number;
          name: string;
          observedAt: number;
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          os: string;
          remoteCreatedAt?: string;
          status: string;
          userKey?: string;
          workspaceId: string;
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { computerId: string; userKey?: string },
        null | {
          computerId: string;
          deletedAt?: number;
          name: string;
          observedAt: number;
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          os: string;
          remoteCreatedAt?: string;
          status: string;
          userKey?: string;
          workspaceId: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; userKey?: string },
        Array<{
          computerId: string;
          deletedAt?: number;
          name: string;
          observedAt: number;
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          os: string;
          remoteCreatedAt?: string;
          status: string;
          userKey?: string;
          workspaceId: string;
        }>,
        Name
      >;
      refresh: FunctionReference<
        "action",
        "internal",
        { computerId: string; userKey?: string },
        null | {
          computerId: string;
          deletedAt?: number;
          name: string;
          observedAt: number;
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          os: string;
          remoteCreatedAt?: string;
          status: string;
          userKey?: string;
          workspaceId: string;
        },
        Name
      >;
      remove: FunctionReference<
        "action",
        "internal",
        { allowDelete: boolean; computerId: string; userKey?: string },
        { deleted: true },
        Name
      >;
      start: FunctionReference<
        "action",
        "internal",
        { computerId: string; userKey?: string; waitSeconds?: number },
        {
          computer: null | {
            computerId: string;
            deletedAt?: number;
            name: string;
            observedAt: number;
            operation?: {
              action: "start" | "stop";
              error?: string;
              errorCode?: string;
              id: string;
              startedAt: number;
              status:
                "queued" | "running" | "succeeded" | "failed" | "needs_review";
              updatedAt: number;
            };
            os: string;
            remoteCreatedAt?: string;
            status: string;
            userKey?: string;
            workspaceId: string;
          };
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          pending: boolean;
        },
        Name
      >;
      stop: FunctionReference<
        "action",
        "internal",
        { computerId: string; userKey?: string; waitSeconds?: number },
        {
          computer: null | {
            computerId: string;
            deletedAt?: number;
            name: string;
            observedAt: number;
            operation?: {
              action: "start" | "stop";
              error?: string;
              errorCode?: string;
              id: string;
              startedAt: number;
              status:
                "queued" | "running" | "succeeded" | "failed" | "needs_review";
              updatedAt: number;
            };
            os: string;
            remoteCreatedAt?: string;
            status: string;
            userKey?: string;
            workspaceId: string;
          };
          operation?: {
            action: "start" | "stop";
            error?: string;
            errorCode?: string;
            id: string;
            startedAt: number;
            status:
              "queued" | "running" | "succeeded" | "failed" | "needs_review";
            updatedAt: number;
          };
          pending: boolean;
        },
        Name
      >;
    };
    executions: {
      get: FunctionReference<
        "query",
        "internal",
        { executionId: string; userKey?: string },
        null | {
          _creationTime: number;
          _id: string;
          computerId: string;
          error?: string;
          exitCode?: number;
          finishedAt?: number;
          input?: string;
          kind: "command" | "python";
          output?: string;
          outputTruncated?: boolean;
          startedAt: number;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "error"
            | "unknown";
          timeoutSeconds: number;
          userKey?: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { computerId: string; limit?: number; userKey?: string },
        Array<{
          _creationTime: number;
          _id: string;
          computerId: string;
          error?: string;
          exitCode?: number;
          finishedAt?: number;
          input?: string;
          kind: "command" | "python";
          output?: string;
          outputTruncated?: boolean;
          startedAt: number;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "error"
            | "unknown";
          timeoutSeconds: number;
          userKey?: string;
        }>,
        Name
      >;
      purge: FunctionReference<
        "mutation",
        "internal",
        { olderThanMs: number },
        { deleted: number; hasMore: boolean },
        Name
      >;
      run: FunctionReference<
        "action",
        "internal",
        {
          computerId: string;
          input: string;
          kind: "command" | "python";
          retainOutput: boolean;
          timeoutSeconds?: number;
          userKey?: string;
        },
        {
          durationMs: number;
          executionId: string;
          exitCode?: number;
          output: string;
          outputTruncated: boolean;
          status: "succeeded" | "failed" | "timed_out";
        },
        Name
      >;
    };
    files: {
      exportFile: FunctionReference<
        "action",
        "internal",
        {
          computerId: string;
          maxBytes?: number;
          path: string;
          userKey?: string;
        },
        {
          bytes: ArrayBuffer;
          contentType?: string;
          filename: string;
          sizeBytes: number;
        },
        Name
      >;
      screenshot: FunctionReference<
        "action",
        "internal",
        { computerId: string; userKey?: string },
        {
          bytes: ArrayBuffer;
          height: number;
          mimeType: "image/png";
          width: number;
        },
        Name
      >;
      upload: FunctionReference<
        "action",
        "internal",
        {
          computerId: string;
          content: ArrayBuffer;
          path: string;
          userKey?: string;
        },
        { path: string; placedIn: string; sizeBytes: number },
        Name
      >;
    };
  };
