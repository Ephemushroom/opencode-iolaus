# Iolaus DAG fan-in with producer provenance

## WHAT WAS TESTED

- `bun test` (17 tests; two new: fan-in `*` expansion with provenance and the
  `node` controller action; field binding and `*` validation)
- `bun run typecheck`, `bun run build`, `bun run check:reference`,
  `bun run check:package`
- Real OpenCode 2.0.16 isolated QA with the local mock model:
  `node script/qa-live.mjs .omo/evidence/20260924-iolaus-dag-fanin-provenance`.
  A new `fanin` scenario creates a three-node DAG: `a` (iolaus-sisyphus) and
  `b` (iolaus-hephaestus) in parallel, then `merge` (iolaus-sisyphus) with
  `dependsOn: ["a","b"]` and `inputs: [{node: "*"}]`.

## WHAT WAS OBSERVED

- All 11 QA checks passed.
- The `merge` child's real user prompt (see `requests.ndjson`, scenario
  `fanin`) carries an `<iolaus-dag-inputs>` block with exactly two entries in
  dependency order. Each entry has `node`, `field`, the upstream `value`
  (`{text: "IOLAUS_FANIN_RESULT_A"}` / `_B`) and `provenance` with `agent`,
  `model`, `attempt`, `status` and the child `sessionID` (`ses_...`). The two
  agents differ (`iolaus-sisyphus`, `iolaus-hephaestus`), proving the merge
  node can tell which subagent produced which conclusion.
- `fanin-trace.ndjson` records `iolaus.dag.run.started`, three
  `iolaus.dag.node.completed` and `iolaus.dag.run.completed`.
- The single-node `dag` scenario, `native`, `agent`, `disabled` and `mode`
  scenarios are unchanged.
- Host state isolation, process cleanup and mock protocol checks passed.

## WHY IT IS ENOUGH

Fan-in is realised as an ordinary Agent node reading every upstream result, so
no new node kind or scheduler path was introduced. The change is confined to
input resolution (`resolveInputs`), graph validation of the `*` binding, one
read-only `node` tool action and the prompt contract. The live scenario
exercises the full host path: parent creates the DAG through `iolaus_dag`, real
child sessions run for all three nodes, and the merge prompt observed at the
model boundary contains the provenance-tagged inputs.
