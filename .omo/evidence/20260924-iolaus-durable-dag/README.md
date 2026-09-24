# Iolaus durable DAG

## WHAT WAS TESTED

- Scoped tests: `bun test`.
- Typecheck: `bun run typecheck`.
- Build and package bundle: `bun run build`.
- Real OpenCode 2.0.15 isolated host QA with local mock Responses model:
  `QA_OPENCODE_BIN=/opt/homebrew/bin/opencode node script/qa-live.mjs .omo/evidence/20260924-iolaus-durable-dag`.
- The live driver covered native behavior, named Iolaus Agent prompt rendering,
  disabled plugin behavior, explicit mode dispatch, and a real `iolaus_dag`
  create/wait path that launched a child Iolaus Agent node.

## WHAT WAS OBSERVED

- Unit suite: 14 tests passed, 0 failed.
- Typecheck and build passed.
- Real host receipt: `receipt.json` reports all 10 checks as PASS, including:
  host version, native session, Agent session, disabled session, mode session,
  DAG session, host-state isolation, process cleanup and mock protocol closure.
- DAG trace contains run-started and node-completed events.
- SQLite WAL state was reopened in a unit test and retained completed run,
  result envelope and event history.
- Host config/session state remained unchanged and every QA-owned process was
  cleaned up.

## WHY IT IS ENOUGH

The unit tests cover deterministic graph validation, canonical fingerprints,
frontier execution, node retry without rerunning completed work, and SQLite
restart persistence. The real host run proves the plugin actually exposes the
new DAG tool while preserving the existing prompt-only Agent and mode behavior.

## WHAT WAS OMITTED

- Full TUI panel and RPC controls are a follow-up after the durable runtime seam.
- Conditional routing, bounded cycles, fan-in aggregators and human gates are
  not included in this first vertical slice.
- No real provider credentials were used. Model calls used a loopback mock.
