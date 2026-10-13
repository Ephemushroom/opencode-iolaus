# Dependency Compatibility Decision

Date: 2026-10-12. Target host: OpenCode 2.0.27. Package manager: Bun 1.4.3.
Consumed the upstream librarian node's dependency/Effect review and independently
verified exact registry metadata, installed declarations/runtime, and live loading.

## Versions Followed

| Dependency | Before | After | Decision |
| --- | --- | --- | --- |
| `@opencode/plugin` (peer/dev) | 2.0.18 | 2.0.27 | Exact target-host pin |
| `@opencode/schema` (dev) | 2.0.18 | 2.0.27 | Match plugin schema |
| `@opencode/client` (transitive) | 2.0.18 | 2.0.27 | Plugin already pins it; no new direct dependency |
| `effect` (dependency/peer) | 4.0.0-rc.112 | 4.0.1 | Exact host dependency/client peer |
| `@opentui/core` (peer/resolved) | >=0.5.10 / 0.5.10 | >=0.5.17 / 0.5.17 | Plugin peer minimum; Solid resolves exact core |
| `@opentui/solid` (peer/dev) | >=0.5.10 / 0.5.10 | >=0.5.17 / 0.5.17 | Plugin peer minimum |
| `solid-js` (peer/dev) | >=1.9.0 / 1.9.12 | unchanged | Compatible with both plugin and Solid |

Registry verification sources:
- https://registry.npmjs.org/@opencode/plugin/2.0.27
- https://registry.npmjs.org/@opencode/schema/2.0.27
- https://registry.npmjs.org/@opencode/client/2.0.27
- https://registry.npmjs.org/@opentui/solid/0.5.17
- https://registry.npmjs.org/effect/4.0.1

The plugin and schema require `effect: 4.0.1`; the client peer also requires
exactly `4.0.1`. Effect latest was `4.0.3`, but it is outside that exact peer
contract. It is intentionally deferred, not assumed runtime-compatible.
`script/build.ts` still externalizes `effect`, `effect/*`, and the plugin SDK.
The installed plugin's `dist/runtime.js` rejects foreign plugin/Effect modules,
so the runtime remains the host's instance rather than a bundled second copy.
Source: https://unpkg.com/@opencode/plugin@2.0.27/dist/runtime.js

The registry also declares optional `@opencode/theme: 2.0.27`; Iolaus does not
directly import it, so no new dependency was added. Bun updated required
OpenCode/Effect transitive packages without an unrelated dependency refresh.

## Relevant Adaptations

OpenCode's `Agent.Info.default` now contains four rules and no longer asks for
`external_directory` globally. This caused two regression tests to fail after
the upgrade. Librarian registration now explicitly asks for external directories
before allowing the existing `iolaus-gh-*` clone root, preserving the tested
clone-only exception instead of silently broadening it. The explore test now
uses the actual default rules' length rather than assuming five rules.
Source: https://unpkg.com/@opencode/schema@2.0.27/dist/agent.js

Effect's reviewed `Scope.close` refinement needs no rewrite: the controller
already passes the closeable scope from `Scope.makeUnsafe()`. Structural search
found no active Effect `partition` calls; no active unstable HTTP API imports
need relocation. Reviewed concurrency/finalizer fixes are consumed through the
aligned dependency, without speculative controller changes or style refactoring.
Effect source reference: https://github.com/Effect-TS/effect

## Deferred Changes

- Session inbox delivery, synthetic idempotency/resumption, and live steering
  remain separate implementation work. No steering was implemented here.
- New `session.remove`/`compact` capabilities do not require changing existing
  session lifecycles; no automatic cleanup behavior was introduced.
- Cluster, SQL, DNS, telemetry, and CLI changes from the upstream Effect review
  do not justify Iolaus source refactors. OpenTUI 0.6.x is not required by this host.
- No TUI/frontend files were changed; full typecheck reports no UI SDK errors.

Official plugin/Effect documentation consulted:
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/effect

## Verification

Initial attempts before installing dependencies were not a valid code baseline:
typecheck could not find Bun types, tests could not resolve packages, and build
timed out at 120 seconds. `bun install --frozen-lockfile` installed the original
lock without changes. The installed baseline then passed:
- `bun run typecheck`: exit 0.
- `bun test`: 317 pass, 0 fail, 1867 assertions across 19 files.
- `bun run build`: exit 0.

After `bun install` updated the manifest/lock, typecheck and package build passed.
The first upgraded test run had 315 pass / 2 fail: default-rule prefix at
`tests/registration.test.ts:204` and external-directory ask at
`tests/gh.test.ts:38`. Both were resolved by the adaptations above.

Final checks:
- `bun run typecheck`: exit 0, including the changed source/test.
- `bun test`: 317 pass, 0 fail, 1867 assertions, 19 files (8.75 seconds).
- `bun run check:package`: exit 0; build and published-file checks PASS.
- `bun run check:reference`: exit 0; 800 reference files verified unchanged.
- `bun install --frozen-lockfile`: exit 0; no lock changes.

Real host QA uses the existing harness with isolated HOME/XDG/IOLAUS_HOME,
a loopback mock model, and standalone OpenCode sessions. Scenarios: native,
agent, disabled, dag, and template-unavailable. All ten assertions passed,
including host 2.0.27, CLI help, successful child execution, unknown-lane
rejection, unchanged real-host state, mock protocol, and process cleanup.
Artifacts: `dependencies-live/` beside this document. This initial smoke run
preceded the explicit librarian permission adaptation; its final-build rerun
is recorded separately in `dependencies-live-final/`, also with all ten
assertions PASS (including host-state isolation and cleanup).

No remaining typecheck/test/build failures. No commits, pushes, global installs,
service restarts, live database mutations, or reference/UI edits were performed.
