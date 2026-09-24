# Iolaus DAG conditional routing and human gate

## WHAT WAS TESTED

- `bun test` (22 tests; five new: condition evaluation, conditional routing
  through the controller, condition validation, gate lifecycle with
  approve/reject/retry/cancel, gate validation)
- `bun run typecheck`, `bun run build`, `bun run check:reference`,
  `bun run check:package`
- Real OpenCode 2.0.16 isolated QA with the local mock model:
  `node script/qa-live.mjs .omo/evidence/20260924-iolaus-dag-routing-gate`.
  A new `route` scenario creates a five-node DAG: `gate` (kind gate, no
  dependencies), `review` (iolaus-sisyphus, bound to the gate result), `ship`
  (`when: review.text includes VERDICT_PASS`), `fix` (iolaus-hephaestus,
  `when: review.text includes VERDICT_FAIL`), `report` (fan-in over ship and
  fix). The mock review child answers `IOLAUS_ROUTE_VERDICT_PASS`. The mock
  parent, standing in for the user, calls `approve` with a note when `create`
  returns `paused`.

## WHAT WAS OBSERVED

- All 12 QA checks passed.
- `route-trace.ndjson` records, in order: `run.started`, `node.waiting` (gate),
  `run.paused`, `node.approved`, three `node.ready`/`node.started`/
  `node.completed` (review, ship, report), `node.skipped` (fix),
  `run.completed`.
- `requests.ndjson`, scenario `route`: the review child's prompt carries the
  gate result `{decision: "approved", note: "QA approved"}` with provenance
  `agent: "human"`. The fix child was never prompted. The report child's
  `<iolaus-dag-inputs>` lists ship as `completed` with its payload and fix as
  `skipped` with a null value.
- `create` returned the run in `paused` with the gate in `waiting_approval`
  and no child session started; the run only progressed after `approve`.
- Earlier scenarios (`native`, `agent`, `disabled`, `mode`, `dag`, `fanin`) are
  unchanged. Host state isolation, process cleanup and mock protocol passed.

## WHY IT IS ENOUGH

Conditional routing and the gate are implemented entirely in the scheduler's
admission pass and two controller actions; no runner or store changes. The
live scenario drives the full host path through `iolaus_dag`: a real paused
run, a real approve call resuming it, real child sessions for the taken
branches, and the skipped branch observably absent at the model boundary. The
unit tests cover the negative paths (reject blocks dependents, retry re-arms
the gate, cancel clears a waiting gate, ownership and non-gate rejections)
that the mock parent does not exercise.
