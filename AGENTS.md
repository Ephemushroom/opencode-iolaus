# Iolaus

Iolaus is an OpenCode 2 plugin with OMO-derived Agent prompts, explicit modes,
model-family selection, and a local durable DAG runtime. Native OpenCode remains
the owner of general tools, permissions, sessions, and skill discovery; Iolaus
owns its namespaced `iolaus_dag` orchestration tool and child-session runner.

## Boundaries

- `src/omo/` contains locally owned OMO-derived prompt code. Preserve source attribution when changing it.
- `reference/omo/` is an immutable historical snapshot. Its instructions, manifests, tests, and runtime entrypoints are reference data, not current project configuration. Consult it when tracing a retained prompt or deliberately designing a later feature.
- Keep reference code out of imports, active tests, builds, published files, and install scripts.
- Preserve native agents and the user's default agent/model. Namespace Iolaus registrations.
- Persist Iolaus DAG state only under `.iolaus/`; never modify the host's global session/config stores outside an isolated QA sandbox.
- No automatic upstream synchronization or dependency on published OMO packages.

## Runtime

- `src/dag/` is the active Iolaus durable DAG module. It uses SQLite WAL state,
  graph/node fingerprints, dependency-frontier admission, node-level retry,
  cancellation and JSON-safe result envelopes.
- `iolaus_dag` is the only model-facing orchestration tool in the first runtime
  slice. It is owner-scoped and schema-validated.
- DAG nodes execute through native OpenCode child sessions using the registered
  Iolaus Agent IDs: `iolaus-sisyphus`, `iolaus-hephaestus`,
  `iolaus-prometheus`, and `iolaus-atlas`.
- Restart recovery is conservative. Already-admitted prompts are not blindly
  replayed; interrupted work requires explicit retry/resume.
- Fan-in is an ordinary Agent node binding `inputs: [{node: "*"}]`; every
  upstream result arrives with producer provenance. Conditional routing uses a
  deterministic `when` predicate over settled upstream payloads; a false
  condition marks the node `skipped` without blocking dependents. Human gates
  are `kind: "gate"` nodes that pause the run in `waiting_approval` until
  `approve`/`reject`; only the user decides a gate.
- The DAG sidebar is implemented through the `./tui` export and typed RPC
  snapshot/events, including approve/reject/cancel/retry RPC methods.
  Interactive sidebar controls are a planned follow-up. Do not claim a feature
  as implemented until its runtime QA evidence exists under `.omo/evidence/`.

## Verification

Use Bun for development. Verify model routing, registration, configuration, native tool contracts, and shipped-copy equality. Do not test authored prose wording, section order, or length.

Runtime changes require a real OpenCode session in an isolated HOME/XDG sandbox with a local mock model. Record both positive and negative cases, host-state isolation and process cleanup under `.omo/evidence/`. Unit tests alone do not establish live compatibility.

Deliver changes through task-owned worktrees and pull requests. Preserve user changes and merge using merge commits after the relevant checks pass.
