# Iolaus Durable DAG implementation

## Goal

Turn Iolaus from a prompt-only OpenCode plugin into a local, durable multi-Agent
orchestrator. Preserve native OpenCode tools and the existing Sisyphus,
Hephaestus, Prometheus, and Atlas prompt registrations. Store all Iolaus-owned
runtime state under `.iolaus/`.

## Scope split

This first implementation is one vertical slice with a deep internal DAG module:

1. SDK/runtime seam: update the exact OpenCode plugin pin to the current host
   version and keep the existing prompt registration behavior intact.
2. Durable store: SQLite WAL schema, migrations, transactions, leases, state
   projections, action log, and event outbox.
3. DAG core: canonical JSON, graph/node fingerprints, graph validation, frontier
   readiness, node state transitions, node-level retry, cancel and recovery.
4. Native execution: an injected OpenCode session runner that starts a child
   session, waits for actual completion, and returns a ResultEnvelope.
5. Native tool: `iolaus_dag` with create, snapshot, wait, cancel, retry, resume,
   and amend actions. No raw SQL or scheduler controls are exposed to the model.
6. Minimal observation seam: typed RPC/event snapshot interface and a TUI entry
   probe, with the full visual panel following after the runtime is stable.
7. QA: unit tests for state/fingerprint/frontier/recovery, isolated real-host QA
   for native DAG execution, positive/negative feature paths, host isolation and
   process cleanup. Evidence under `.omo/evidence/YYYYMMDD-iolaus-durable-dag/`.

## Architecture decisions

- Product and state namespace: `Iolaus` and `.iolaus`; no secondary product name.
- Persistence: embedded `bun:sqlite`, WAL, foreign keys, busy timeout, atomic
  transactions. No Temporal server, port, worker process or network queue.
- Recovery: state table plus action log. Startup reconciles `starting` and
  `running` nodes as interrupted/needs_retry; it never blindly replays an
  already-admitted prompt.
- Scheduling: dependency frontier. A completed node immediately unlocks eligible
  descendants while unrelated roots continue independently.
- Versioning: SHA-256 graph fingerprint plus node fingerprint. An amend reuses a
  completed node only when its definition and upstream input closure are unchanged.
- Data flow: JSON-safe ResultEnvelope with generation and provenance. Prompts stay
  unchanged by default; downstream input binding is explicit.
- Execution: the DAG scheduler knows only the `DagRunner` interface. The OpenCode
  adapter owns session creation, agent/model selection, prompt admission and
  completion observation.
- TUI: reads snapshots and typed events through the plugin RPC/event seam. It
  never opens the database or owns scheduling logic.

## Data model

SQLite tables:

- `dag_runs`: definition, graph fingerprint, status, generation and checkpoint.
- `dag_nodes`: node definition, node fingerprint, dependency bindings, state,
  attempts, result, error and execution reference.
- `dag_actions`: idempotent state-changing actions and audit payloads.
- `dag_checkpoints`: safe-boundary state, graph fingerprint, lineage and cursor.
- `dag_events`: versioned lifecycle/progress/output/retry/cancel/checkpoint events.
- `dag_leases`: controller token, PID, host, heartbeat and expiry.

Node states:

```text
pending → ready → starting → running → completed
                         ├──────→ failed
                         ├──────→ interrupted
                         └──────→ cancelled
completed/reused → downstream frontier
failed/interrupted → needs_retry or blocked descendants
```

## Implementation order

### Unit A: package and plan foundation

- Update package metadata/lockfile to the supported OpenCode SDK.
- Add this plan and preserve the current prompt-only behavior tests.
- Add the DAG module public types and fake runner seam.

Verification: `bun test`, `bun run typecheck`, `bun run build`.

### Unit B: durable store and fingerprints

- Add `.iolaus/dag/state.db` resolution with `IOLAUS_DAG_DB` override.
- Add schema migration and WAL initialization.
- Implement canonical JSON and graph/node fingerprints.
- Implement transaction helpers, action idempotency and controller lease.

Verification: migration, rollback, concurrent writer, stale lease, fingerprint
stability and path-isolation tests.

### Unit C: frontier scheduler

- Validate DAG nodes, duplicate IDs, missing dependencies and cycles.
- Compute readiness and blocked descendants.
- Atomically claim ready nodes against model/agent/session limits.
- Persist transitions before runner calls.
- Implement node retry with attempt/generation checks.
- Implement cancel/drain and startup reconciliation.

Verification: independent roots, immediate descendant admission, capacity queue,
cancelled queued node never launches, stale retry conflict, recovery state and
idempotent actions.

### Unit D: OpenCode runner and native tool

- Register `iolaus_dag` only when Iolaus is enabled.
- Add action schemas and owner/session validation.
- Create child sessions for Agent nodes using the registered Iolaus Agent IDs.
- Wait for real host completion rather than treating prompt acceptance as done.
- Convert results into bounded JSON-safe envelopes.
- Add snapshot/wait/retry/resume/amend responses.

Verification: local mock model and real isolated OpenCode session prove Sisyphus,
Hephaestus, Prometheus and Atlas can be selected as DAG nodes; native tools remain
available; disabled Iolaus has no DAG tool.

### Unit E: fan-in and amend

- Add `aggregator` nodes and explicit input bindings.
- Add `all`, `quorum`, `best_effort` and `deadline` join policy.
- Persist provenance and deterministic source ordering.
- Implement amend invalidation and unaffected-node reuse.

Verification: partial member failure, quorum success, aggregator retry, changed
node invalidates descendants, unchanged node reuses result, old generation cannot
overwrite a newer result.

### Unit F: event seam and TUI smoke

- Add versioned typed DAG events through the existing plugin trace/event seam.
- Add RPC snapshot and action endpoints for TUI clients.
- Add `./tui` build/export entry and a minimal panel/footer probe.
- Add tmux TUI smoke for boot, empty state, active run, cancel and cleanup.

Verification: real host TUI loads the Iolaus TUI entry, receives a snapshot, sends
one action, and exits with no leaked process or modified host state.

## QA and evidence

Before and after implementation, run the real OpenCode host in isolated HOME and
XDG directories with a local mock Responses model. Record:

- host version and plugin load trace
- positive DAG execution
- negative disabled/native paths
- restart/reconcile path
- retry/cancel/frontier path
- amend/fan-in path
- TUI smoke output
- real host config/session counts before and after
- process cleanup receipt

All artifacts go under:

```text
.omo/evidence/YYYYMMDD-iolaus-durable-dag/
```

The evidence README must state what was tested, observed behavior, why the
evidence covers the change, and what was omitted.

## Success criteria

- The four core Iolaus Agent registrations remain namespaced and preserve native
  OpenCode Agents/defaults/tools.
- A local SQLite WAL DAG survives process restart and exposes deterministic node
  state, retry and recovery.
- Dependency frontier dispatches eligible nodes immediately without batch barriers.
- Result envelopes and aggregator nodes make multi-Agent output consumable by
  downstream nodes.
- `iolaus_dag` is owner-scoped, schema-validated and absent when disabled.
- The minimal TUI can observe and control a live DAG through RPC/events.
- Unit/type/build gates pass and isolated real-host evidence is written before PR.

## Explicit follow-ups

- Conditional routing and bounded feedback loops after the acyclic core is stable.
- Generic human gates and approval requests after checkpoint storage is proven.
- Full TUI graph visualization and historical event timeline after the snapshot
  seam is stable.
- Evaluation helpers for expected Agent/tool/result behavior.
