# Judge nodes and the dynamic review loop

## WHAT WAS TESTED

- `kind: "judge"`: the OpenCode runner makes one `ctx.generate.text` call on
  the node's model (no child session) and returns the reply from `wait`. All
  template reviewers (plan-review, goal-review, ultrawork, hyperplan) are
  judges.
- `DagDefinition.loop` + `src/dag/loop.ts`: after a launch settles, `grow`
  checks whether the settled node is the loop's newest review, completed with
  `failIncludes` and without `passIncludes`, and rounds remain; if so it appends
  `<fix><n>` and `<review><n>`, rewires `tail` nodes to the new review, bumps
  the generation and emits `loop.grown`. The ultrawork template now creates
  `work`, `review`, `accept` plus the loop spec.
- `bun test` 70 pass (loop growth two FAILs → PASS with gate rewired to
  review2; first PASS grows nothing; maxRounds exhausted completes with the gate
  skipped; judge runner makes exactly one generate call and no session).
- Real OpenCode 2.0.16 isolated QA (26 checks): `.omo/evidence/20260926-iolaus-judge-loop/`.

## WHAT WAS OBSERVED

- All 26 checks passed. `ultrawork-dag` (real `/iolaus-ultrawork`): nodes ran
  `work → review → work1 → review1 → work2 → review2`, two `iolaus.dag.loop.grown`
  traces (`review`, `review1`), zero `iolaus.agent.rendered` for momus (judge
  reviews open no session), gate waited and was approved, `run.completed`.
  `template` (plan-review) unchanged in behaviour with judge reviews.
- Harness fact: `generate.text` requests carry no `instructions`; the mock
  now records an empty string so prompt assertions keep working.

## WHY IT IS ENOUGH

Loop growth is pinned by unit tests on all three outcomes and observed live via
`loop.grown`; judge execution is pinned by the runner test and observed live
by the absence of reviewer sessions.

## KNOWN LIMITS

- Judge calls have no tools; a judge can only read what its prompt (with
  `<iolaus-dag-inputs>`) contains. That is what a review needs.
- Growth happens only for the node named as the loop's review; multi-loop
  definitions are not supported.
