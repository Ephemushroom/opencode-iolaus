# Iolaus DAG prompt semantics

## WHAT WAS TESTED

- `bun test`
- `bun run typecheck`
- `bun run build`
- Real OpenCode 2.0.15 isolated QA with the local mock model:
  `node script/qa-live.mjs .omo/evidence/20260924-iolaus-dag-prompt`.

## WHAT WAS OBSERVED

- All 10 QA checks passed, including native behavior, named Iolaus Agent prompt
  rendering, disabled plugin behavior, explicit modes and the DAG create/wait
  flow.
- The DAG scenario launched `iolaus-sisyphus` as a child node, completed the
  node, and emitted `iolaus.dag.node.completed` and `iolaus.dag.run.completed`.
- Prompt binding now directs multi-step planning, dependencies, retries and
  recovery to `iolaus_dag`; native subagent remains for one-off consultation.
- Existing OMO-derived Agent prompt sources remain active and model-family
  routing tests pass.
- Host state and process cleanup passed. Model traffic used the local mock only.

## WHY IT IS ENOUGH

The prompt change is verified through the real host path that renders an Iolaus
Agent and then runs a real DAG child. The native binding is applied after the
inherited prompt, so the runtime contract is the final instruction layer while
the OMO-derived Agent role and model routing remain intact.

## WHAT WAS OMITTED

- Prompt source prose is not tested by string snapshots. Behavior is checked at
  Agent registration, model routing, tool visibility, DAG execution and trace
  events.
- Fan-in aggregators, conditional routing and human gates remain future DAG
  capabilities.
