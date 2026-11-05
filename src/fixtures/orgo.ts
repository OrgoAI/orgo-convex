// Orgo response fixtures, shaped from https://docs.orgo.ai/api-reference.
// `live.ts` holds responses captured from a real computer.
// Every credential is a sentinel the tests assert never escapes.

export const SECRET = {
  apiKey: "sk_test_SENTINEL_api_key_0123456789",
  vncPassword: "SENTINEL_vnc_password",
  desktopToken: "SENTINEL_desktop_api_token",
  signedUrl: "https://objects.example.com/x?X-Amz-Signature=SENTINEL_signature",
} as const;

export const SENTINELS = [
  SECRET.apiKey,
  SECRET.vncPassword,
  SECRET.desktopToken,
  "SENTINEL_signature",
];

export const COMPUTER_ID = "6f0c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
export const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440000";
export const OPERATION_ID = "0b6d7c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e";

/** POST /api/computers → 201 (app/api/computers/route.ts computerCreatedResponse). */
export const createdComputer = {
  id: COMPUTER_ID,
  name: "convex-test",
  workspace_id: WORKSPACE_ID,
  project_id: WORKSPACE_ID,
  os: "linux",
  cpu: 1,
  ram: 4,
  resolution: "1024x768x24",
  status: "running",
  url: "https://orgo.example/vnc",
  created_at: "2026-10-20T23:00:00.000Z",
  instance_id: "vm-123",
  fly_instance_id: "vm-123",
  hostname: "host.example",
  connection_url: "https://host.example",
  vnc_password: SECRET.vncPassword,
  instance_details: { desktopApiToken: SECRET.desktopToken, resolution: "1024x768x24" },
};

/** GET /api/computers/{id} → 200 (no workspace_id, only project_id). */
export const fetchedComputer = {
  id: COMPUTER_ID,
  project_id: WORKSPACE_ID,
  permissions: { canWrite: true },
  instance_details: { resolution: "1024x768x24" },
  name: "convex-test",
  project_name: "Scratch",
  os: "linux",
  ram: 4,
  cpu: 1,
  status: "frozen",
  url: "https://orgo.example/vnc",
  fly_instance_id: "vm-123",
  created_at: "2026-10-20T23:00:00.000Z",
  hostname: "host.example",
  connection_url: "https://host.example",
  vnc_password: SECRET.vncPassword,
  private_screens: false,
  hardware: null,
  device_tag: null,
  asleep: null,
  suspension: null,
};

/** POST start|stop with {async:true} → 202 (lib/api/computer-lifecycle.ts acceptedOperation). */
export function acceptedLifecycle(action: "start" | "stop") {
  const operation = {
    id: OPERATION_ID,
    desktop_id: COMPUTER_ID,
    action,
    status: "queued",
    result: null,
    error: null,
    created_at: "2026-10-20T23:00:00.000Z",
    updated_at: "2026-10-20T23:00:00.000Z",
    poll_url: `/api/computers/${COMPUTER_ID}/operations/${OPERATION_ID}`,
  };
  return {
    id: COMPUTER_ID,
    status: action === "stop" ? "stopping" : "starting",
    operation_id: OPERATION_ID,
    operation,
    poll_url: operation.poll_url,
  };
}

/** GET /api/computers/{id}/operations/{opId} (lib/computer-operations.ts publicOperation). */
export function operation(
  action: "start" | "stop",
  status: "queued" | "running" | "succeeded" | "failed" | "needs_review",
  error: { error: string; code: string; status: number } | null = null,
) {
  return {
    ...acceptedLifecycle(action).operation,
    status,
    result: status === "succeeded" ? { success: true } : null,
    error,
  };
}

/** Linux bash (docs.orgo.ai/api-reference/computers/bash). */
export const bashLinuxOk = {
  success: true,
  action: "bash",
  command: "echo hello",
  output: "hello",
  exit_code: 0,
  error: null,
  error_type: null,
};
export const bashLinuxExit3 = { ...bashLinuxOk, command: "exit 3", output: "", exit_code: 3 };
/** A Linux command killed by its timeout: exit_code -1, no flag. */
export const bashLinuxKilled = { ...bashLinuxOk, command: "sleep 30", output: "", exit_code: -1 };
/** Windows PowerShell answers with separate streams. */
export const bashWindowsTimeout = {
  stdout: "partial",
  stderr: "",
  exit_code: 124,
  output: "partial",
  error: "timeout",
};
export const bashWindowsStreams = { stdout: "out", stderr: "err", exit_code: 1 };

/** Linux exec: no exit code; success true only on exit 0. */
export const execLinuxOk = {
  success: true,
  action: "exec",
  output: "42",
  timeout: false,
  error: null,
  error_type: null,
};
export const execLinuxRaised = {
  ...execLinuxOk,
  success: false,
  output:
    'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nValueError: boom',
};

/** POST /api/files/upload with destPath → 200. */
export const uploadPlaced = { ok: true, placedIn: "/tmp" };

/** POST /api/files/export → 200. */
export const exported = {
  success: true,
  file: {
    id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    project_id: WORKSPACE_ID,
    desktop_id: COMPUTER_ID,
    filename: "x.txt",
    storage_key: `${WORKSPACE_ID}/${COMPUTER_ID}/exports/1-x.txt`,
    size_bytes: "5",
    content_type: "text/plain",
    source: "export",
  },
  url: SECRET.signedUrl,
};

/** A minimal PNG: signature + IHDR for the given size, then filler. */
export function pngBytes(width: number, height: number, filler = 64): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(33 + filler);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}
