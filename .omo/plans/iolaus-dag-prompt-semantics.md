# Iolaus DAG prompt semantics

## Goal

Keep the OMO-derived roles for Sisyphus, Hephaestus, Prometheus, Atlas and the
specialist Agents, but make Iolaus's durable DAG the only multi-step execution
and progress contract.

## Migration rules

- Use native `subagent` for one-off research or consultation.
- Use `iolaus_dag` for multi-step implementation, dependencies, parallel work,
  retry, cancellation and recovery.
- Name exact Iolaus Agents in graph nodes.
- Use `snapshot` or `wait` before reporting completion.
- Put plans in `.iolaus/plans/`; do not create a separate todo state.
- Do not advertise OMO-only `task`, `todowrite`, `background_output`, Team or
  idle-continuation semantics as available Iolaus tools.

## Verification

- Existing registration and model-family tests remain green.
- Native binding renders the Iolaus DAG contract after inherited OMO prompt text.
- Real OpenCode 2.0.15 QA runs an Agent-rendered DAG create/wait flow and asserts
  `iolaus.dag.node.completed` and `iolaus.dag.run.completed`.
- Host state, process cleanup and mock protocol remain isolated.

## Follow-ups

- Replace residual explanatory OMO task examples with generated Iolaus DAG
  examples once the prompt-source migration is reviewed as a separate slice.
- Add fan-in aggregator guidance after the runtime exposes aggregator nodes.
