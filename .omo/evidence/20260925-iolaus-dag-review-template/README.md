# Iolaus DAG review templates and fail-closed routing

## WHAT WAS TESTED

- `src/dag/templates.ts`: `plan-review` and `goal-review` expand to ordinary
  definitions (Prometheus/Hephaestus produce, Momus reviews with a trailing
  `VERDICT: PASS|FAIL`, a `when` branch revises/fixes on FAIL, re-review, a
  human gate, then the executor). `iolaus_dag` gains action `template` and
  accepts `template` on `create`.
- `applyDefaultModels` is fail-closed: an agent node with no `model` whose lane
  resolves to nothing throws `model_unavailable: no configured model for
  <node> (<lane>)` before any run is stored.
- Scheduler fix found while testing the template: a node whose dependency was
  skipped in the same scheduling pass stayed `pending` forever (order-dependent).
  The frontier is now re-scanned until stable.
- `bun test` (56 tests, 5 new in `tests/dag-templates.test.ts`; one existing
  models test updated for fail-closed), typecheck, build, `check:reference`,
  `check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-dag-review-template`.

## WHAT WAS OBSERVED

- All 22 QA checks passed.
- `template` (build agent, models config pins prometheus/momus/sisyphus to the
  mock model): the model called `iolaus_dag create` with
  `template: {template: "plan-review", task, executor: "iolaus-sisyphus"}`.
  The returned run's `plan` node carries `agent: iolaus-prometheus` and the
  configured model. Child sessions ran in order plan → review → revise →
  rereview; the scripted Momus answered `VERDICT: FAIL` first and `VERDICT:
  PASS` on the revised plan. The `revise` prompt contained the v1 plan and the
  review's defect text via `<iolaus-dag-inputs>`; the `execute` prompt
  contained the v2 plan. The run paused at the `approve` gate
  (`iolaus.dag.node.waiting`, `run.paused`), the model approved it, `execute`
  ran, `run.completed`.
- `template-unavailable` (reviewer lane `iolaus-no-such-lane`): the tool
  returned `{"error": "model_unavailable: no configured model for review
  (iolaus-no-such-lane), rereview (iolaus-no-such-lane); set model on the node
  or configure the lane in .iolaus/models.json"}`. No `iolaus.dag.run.started`
  trace; no child session was rendered.
- Earlier scenarios (route, fanin, lanes, gates, ast_grep, MCPs, verify) are
  unchanged and pass.
- Unit tests: template expansion validates against the graph rules; unknown
  template, empty task, bad `gate`/`maxAttempts` rejected; fail-closed create
  through both controller and tool; three simulated runs (FAIL→revise→PASS→gate
  →execute; PASS skips revise/rereview; double FAIL leaves the gate skipped).

## WHY IT IS ENOUGH

The live run drives the whole template through the real tool and real child
sessions, including the conditional branch, input provenance and the gate. The
negative run proves an unroutable lane is refused at create, with the node and
lane named, and leaves no run behind.

## KNOWN LIMITS

- The verdict contract is textual (`VERDICT: PASS|FAIL` on the last line);
  a reviewer that omits it is treated as not passing, so the gate is skipped
  and the run completes without execution. Inspect `rereview` in that case.
- `wait` resolves only on terminal runs; a paused run is observed via
  `snapshot`. The QA mock does this; the DAG sidebar already shows paused runs.
