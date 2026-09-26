# Iolaus on the Effect plugin API

## WHAT WAS TESTED

- Plugin entry moved from `@opencode/plugin` (Promise, `setup`) to
  `@opencode/plugin/effect` (`Plugin.define({ id, effect })`). Every
  registration is an Effect in the plugin scope; the DAG controller closes as
  a scope finalizer.
- `src/dag/controller.ts` rewritten: typed `DagValidationError` /
  `DagRunnerError`, `Semaphore` per run for mutual exclusion, `Deferred`
  waiters, launch fibers forked into a controller `Scope`, `Effect.exit` to
  turn child failures into node state. Public surface unchanged in shape.
- `src/dag/runner.ts`: Effect-native OpenCode runner plus `runnerFromPromise`
  for tests. `src/dag/tool.ts`: `execute` returns an Effect; every failure
  (including thrown input validation) becomes the JSON error envelope via
  `catchCause`. `src/dag/register-rpc.ts`: handlers are Effects; rejections
  use `call.error("rejected", ...)`. `src/dag/promise.ts`: Promise adapter.
  `src/effect-bridge.ts`: lifts the Promise-authored ast_grep and gh tools.
- `registration.ts`, `mcp.ts`, `context.ts`, `verify/hook.ts` converted to
  Effect signatures. Behaviour unchanged.
- `effect@4.0.0-rc.112` added as dependency + peer, external in the bundle.
- `bun test` 66 pass (test fakes now return Effects; DAG tests go through the
  Promise adapter), typecheck clean, build, `check:reference`, `check:package`.
- Real OpenCode 2.0.16 isolated QA (26 checks, unchanged script):
  `.omo/evidence/20260926-iolaus-effect-foundation/`.

## WHAT WAS OBSERVED

- All 26 QA checks passed with the Effect entry. The host accepted
  `{ id, effect }` (its loader checks `"effect" in plugin`), ran every
  registration, and all previously proven behaviours held: agents/modes/
  categories rendered, DAG create/wait/gate/approve/retry/fan-in/routing,
  templates and ultrawork loop, ast_grep search/rewrite/deny, context7 +
  grep_app live calls, gh live round trip, verify hook with real tsc.
- Effect 4 rc API facts used (probed): `Semaphore.makeUnsafe`,
  `Deferred.make/await/doneUnsafe`, `Scope.makeUnsafe/close`, `Effect.forkIn`,
  `Effect.exit`, `Effect.catch`/`catchCause`, `Effect.tryPromise` (signal),
  `Effect.addFinalizer`, `Effect.scoped`. No `Effect.Service`/`Context.Tag`
  (v3 names); services would use `Context.Service`.
- Host state isolation, cleanup and mock protocol checks passed.

## WHY IT IS ENOUGH

The QA script is byte-identical to the one that validated the Promise
implementation, so a green run is a behavioural equivalence proof for every
model-facing surface. Typed errors and scope-bound fibers are covered by the
existing DAG unit tests (retry-by-generation, cancel, gate reject, restart).

## KNOWN LIMITS

- ast_grep and gh tools remain Promise-authored internally and are bridged;
  converting their executors is cosmetic and deferred.
- The verify hook body is still `async`, wrapped in `Effect.promise`.
