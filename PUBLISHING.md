# Publishing

Releases go to npm from GitHub Actions (`.github/workflows/release.yml`) with trusted publishing and
provenance when a `v*` tag is pushed. No npm token is stored in this repository.

## Releasing

1. Run the live test against a scratch workspace if the release changes any Orgo call
   (`npm run test:live`, see [CONTRIBUTING.md](./CONTRIBUTING.md)).
2. Update `CHANGELOG.md`, then `npm version <patch|minor|major>` (creates the commit and tag).
3. `git push --follow-tags`. The workflow checks the tag matches `package.json`, runs
   `./scripts/verify` and publishes. Prereleases (`npm run alpha`) go to the `alpha` dist-tag.

## First-time setup

Once, by an owner of the npm package:

1. Publish the first version by hand from a clean checkout of the release commit (npm ≥ 11.5.1, Node
   ≥ 22.14): `npm ci && ./scripts/verify && npm publish --access public`. Publish from an
   organization account and add a second owner.
2. On npmjs.com → `orgo-convex` → Settings → Trusted publishing, add GitHub Actions with this
   repository, workflow `release.yml` and environment `npm`, and allow `npm publish`.
3. Check it with a prerelease from CI (`npm run alpha`), then set "Require two-factor authentication
   and disallow tokens".

On GitHub, keep Settings → Code security → Private vulnerability reporting on: the README sends
security reports there.

## Hosted demo

The Convex components directory asks for a demo link. In a Convex cloud project, in this order:

```bash
npx convex env set --prod ORGO_API_KEY      # paste a key for a workspace used only by the demo
npx convex deploy
npx convex run --prod demo:setup '{"workspaceId":"<workspace id>"}'
cd example && VITE_CONVEX_URL=<production URL> npx vite build   # host example/dist anywhere static
```

Visitors get fixed commands on one computer, one action every three seconds and at most 300 a day
across everyone. `npx convex run --prod demo:pause` stops it at once; `demo:resume` restarts it. It
costs one always-on Orgo computer plus Convex usage for at most 300 actions a day.

## Upkeep

- The component depends on these Orgo endpoints; a breaking change to any of them breaks every
  installed copy: `POST /api/computers`, `GET|DELETE /api/computers/{id}`,
  `POST /api/computers/{id}/start|stop`, `GET /api/computers/{id}/operations/{operationId}`,
  `POST /api/computers/{id}/bash|exec`, `GET /api/computers/{id}/screenshot`,
  `POST /api/files/upload`, `POST /api/files/export`, `DELETE /api/files/delete`.
- For a new response shape, add a fixture in `src/fixtures/` and a test next to its parser in
  `src/component/wire.ts`.
- Keep the lowest Convex version in CI (`1.43.0`) in step with `peerDependencies`.
