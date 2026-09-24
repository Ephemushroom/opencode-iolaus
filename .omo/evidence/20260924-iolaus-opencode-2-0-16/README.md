# Iolaus on OpenCode 2.0.16

## WHAT WAS TESTED

- `@opencode/plugin` peer and dev dependency bumped 2.0.15 -> 2.0.16.
- `script/qa-live.mjs` host version assertion moved to 2.0.16.
- `bun install`, `bun run typecheck`, `bun test` (15), `bun run check:reference`,
  `bun run check:package`, `bun run build`.
- Real OpenCode 2.0.16 isolated QA with the local mock model:
  `node script/qa-live.mjs .omo/evidence/20260924-iolaus-opencode-2-0-16`.

## WHAT WAS OBSERVED

- All 10 QA checks passed, including `host version` against 2.0.16.
- Native, named Iolaus Agent, disabled plugin, explicit mode and DAG scenarios
  behave as on 2.0.15. The mode scenario still drops the native default prompt
  (`nativePromptRemoved: 1` in `mode-trace.ndjson`).
- Host state isolation, process cleanup and mock protocol checks passed.

## WHY IT IS ENOUGH

The plugin surface Iolaus uses (agent/command/tool transforms, session context
hook, session prompt, RPC registration) typechecks unchanged against the 2.0.16
package, and every live scenario ran against the real 2.0.16 binary.
