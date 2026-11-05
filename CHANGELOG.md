# Changelog

## 0.1.0 (2026-11-04)

First release.

- Computers: `createComputer`, `getComputer`, `listComputers`, `refreshComputer`, `startComputer`,
  `stopComputer` (bounded wait, pending operations settled by refresh) and `deleteComputer` (off
  unless `allowDelete: true`).
- Commands: `runCommand` (bash, or PowerShell on Windows) and `runPython`, with `succeeded`,
  `failed`, `timed_out`, `error` and `unknown` outcomes recorded per run; `getExecution`,
  `listExecutions`, `purgeExecutions`. Rows keep metadata only unless `retainOutput: true`.
- Files: `screenshot` (PNG bytes and size), `uploadFile` and `exportFile` by absolute path.
- Every call about a computer checks its `userKey` before contacting Orgo.
- Structured errors (`orgoErrorData`) that never carry raw responses, URLs or keys.
- `orgo-convex/test` for convex-test, and a public-safe demo app in `example/`.
