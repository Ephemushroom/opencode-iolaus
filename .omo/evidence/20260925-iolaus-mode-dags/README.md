# Iolaus modes as DAG templates (ultrawork, hyperplan)

## WHAT WAS TESTED

- `src/dag/templates.ts`: `ultrawork` (loop unrolled to `work`, `review`,
  `fix1`, `review1`, ... up to `iterations`, each round guarded by the previous
  verdict, then `accept` gate) and `hyperplan` (parallel `analyze-*`,
  `attack-*` with fan-in, `defend-*` with fan-in, `distill` by Metis, `plan` by
  Prometheus, `review` by Momus, `approve` gate; `maxParallel` = member count).
- `src/prompts/mode-dag.ts`: the session that receives `/iolaus-ultrawork` or
  `/iolaus-hyperplan` gets the OMO mode prompt plus an `<iolaus-mode-dag>`
  block instructing it to create the template and wait. Worker children carry
  the mode marker plus `<iolaus-dag-child>`, which suppresses that block so
  they work under the ultrawork prompt instead of spawning another run.
- `bun test` (59 tests, 3 new; two context tests updated for the appended
  block), typecheck, build, `check:reference`, `check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-mode-dags`.

## WHAT WAS OBSERVED

- All 23 QA checks passed.
- `ultrawork-dag`: `opencode run "/iolaus-ultrawork IOLAUS_ULTRAWORK_TASK"` on
  the build agent. The commanding session's system prompt contained the
  ultrawork prompt and `<iolaus-mode-dag template="ultrawork">`
  (`iolaus.mode.rendered {dag: "ultrawork"}`). The model created the template
  with `iterations: 3`. Child sessions ran `work → review → fix1 → review1 →
  fix2 → review2` in order; the scripted Momus failed rounds 0 and 1 and passed
  round 2. Every worker child's request carried `<iolaus-dag-child>` in its
  message, had the ULTRAWORK prompt in its system prompt, and had no
  `<iolaus-mode-dag>` block (`mode.rendered {dag: null}` ×3). `fix2`'s prompt
  contained `fix1`'s result and `review1`'s defect text. The run paused at
  `accept`, the model approved, `run.completed`.
- Host fact: `opencode run "/iolaus-<mode> ..."` expands the command
  client-side, so the plugin command's `execute` and its
  `iolaus.mode.dispatched` trace are not exercised by this path (the existing
  `mode` scenario shows the same). The context hook is the effective mechanism.
- Unit tests: ultrawork unrolling and inputs, early stop when the first review
  passes (all later rounds `skipped`), a three-round scripted run; hyperplan
  node graph, member overrides and validation, a scripted run proving
  `attack-*` sees every analysis and `review` sees the distilled bundle;
  `modeDagInstruction` present for ultrawork/hyperplan, absent for team, and
  absent for child prompts.
- Earlier scenarios unchanged. Host state isolation, cleanup and mock protocol
  checks passed.

## WHY IT IS ENOUGH

The live run starts from the user-facing command and ends with a completed
DAG through real child sessions, proving the mode → template → loop → gate
chain and that workers do not recurse. Hyperplan shares every mechanism
(templates, fan-in, gate) already exercised live; its specific shape is
covered by unit tests with a scripted runner.

## KNOWN LIMITS

- The loop is bounded by `iterations` (max 10) and unrolled at create time; a
  run that exhausts its rounds completes without the gate, not with a failure.
- Hyperplan was not run live end to end (four parallel category children plus
  four more rounds); the graph is unit-tested.
- Whether the model obeys the `<iolaus-mode-dag>` block is a prompt matter; the
  QA mock complies by construction.
