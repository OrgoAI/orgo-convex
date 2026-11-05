# Contributing

## Running locally

```sh
npm ci
npm run dev
```

`npm run dev` uses a local Convex deployment. Without a Convex login, run it once as
`CONVEX_AGENT_MODE=anonymous npm run dev`.

## Checks

```sh
./scripts/verify
```

That runs what CI runs: build, lint, format, typecheck, tests and the package contents check.
`npm run format` fixes formatting.

## Live test

The unit tests fake Orgo. `npm run test:live` drives a real Orgo workspace through the Convex
deployment `npx convex dev` uses: it creates one computer, runs commands and Python, takes a
screenshot, round-trips files, stops and starts the computer, deletes it, then checks that the
component's tables hold no credentials. It deletes the computer even when a check fails.

```sh
ORGO_API_KEY=sk_live_... ORGO_WORKSPACE_ID=<uuid> npm run test:live
```

Use a scratch workspace, never one with computers doing real work. Add `CONVEX_AGENT_MODE=anonymous`
to run against a local deployment.

## Layout

- `src/component/`: the Convex component (schema, functions, Orgo HTTP client, response parsers).
- `src/client/`: the `Orgo` class host apps use.
- `src/test.ts`: the `orgo-convex/test` helper for convex-test.
- `example/`: the demo app, also used for codegen and the live test.
