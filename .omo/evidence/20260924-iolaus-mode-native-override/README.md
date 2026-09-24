# Iolaus mode dispatch overrides the native default prompt

## WHAT WAS TESTED

- `bun test` (15 tests, including a new unit test for the mode path)
- `bun run typecheck`
- `bun run build`
- Real OpenCode isolated QA with the local mock model:
  `node script/qa-live.mjs .omo/evidence/20260924-iolaus-mode-native-override`.
- A one-off probe (not retained) traced `event.system` inside the context hook
  for the mode scenario. OpenCode 2.0.16 delivers four text parts: the default
  agent prose (2825 chars, starts with "You are an AI agent running in
  OpenCode, a coding agent harness"), `# Your Model`, an environment part that
  also carries `<env>` and `# Code Mode`, and a worktree hint.

## WHAT WAS OBSERVED

- 9 of 10 QA checks passed. `host version` failed because the sandbox binary is
  OpenCode 2.0.16 while `script/qa-live.mjs` asserts 2.0.15. This is a host
  upgrade on the QA machine, not a behaviour change in Iolaus.
- `mode` scenario request (`requests.ndjson`, scenario `mode`): the native prose
  block, `# Harness`, `# Communication` and the `# Delegation` "Do not spawn
  subagents" clause are absent. `# Your Model`, `<env>`, `# Code Mode` and the
  Iolaus mode prompt with `<iolaus-native-contract>` are present.
- `mode-trace.ndjson` records `iolaus.mode.rendered` with
  `nativePromptRemoved: 1`.
- `native`, `disabled` and top-level `dag` scenarios still carry the full native
  prompt: the removal only fires when an explicit `/iolaus-<mode>` marker is
  matched. `agent` and DAG child scenarios were already free of the native
  prompt through the custom `agent.system` path and remain so.
- Host state isolation, process cleanup and mock protocol checks passed.

## WHY IT IS ENOUGH

The change is a single, prefix-matched removal in `composeContext`, exercised
through the real host context hook against the real system-part layout observed
in the probe. Positive case (mode request loses the native prose) and negative
cases (native, disabled, DAG parent unchanged) are both captured in the same
run.
