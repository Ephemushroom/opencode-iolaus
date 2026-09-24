# Iolaus DAG TUI delivery

Goal: ship a native OpenCode 2.0.15 DAG panel backed by location-scoped RPC,
with owner-session run selection, live refresh, node details and controls.

## Work and verification ledger

- [x] Create task worktree; inspect exact 2.0.15 TUI, RPC and client declarations.
- [x] Add draft RPC contract, controller list/event callback, and sidebar entry.
- [ ] In progress: include TSX in typechecking; fix RPC events subscription and
  package loading; prove the entry loads in full TUI in an isolated tmux server.
- [ ] Complete session/location-aware view loading, error handling, refresh
  coalescing and teardown; test stale session responses and reconnect behavior.
- [ ] Add selectable panel, node details and refresh/cancel/retry commands through
  RPC; verify session ownership and action validation with meaningful tests.
- [ ] Publish invalidations only after durable state saves, with failure-isolated
  delivery; verify snapshot observed at event delivery includes the transition.
- [ ] Check cancellation/retry semantics exposed by UI; fix directly blocking
  races before enabling those actions and add regression coverage.
- [ ] Replace provisional QA driver with allowlisted HOME/XDG environment,
  dedicated tmux socket, local mock model, exact captured RPC/events and both
  enabled/disabled UI cases; assert cleanup and host session counts/config hashes.
- [ ] Correct auto-loading documentation and package bundle boundaries; update
  AGENTS.md to describe only observed behavior.
- [ ] Run tests, TS/TSX typecheck, build, package/reference checks and live QA.
- [ ] Open English PR with evidence, pass CI and merge with merge commit.
- [ ] Preserve evidence and clean worktree; report final capabilities and limits.

Files: src/tui.tsx and src/tui/* for UI; src/dag/rpc.ts and RPC registration
module for transport; src/dag/controller.ts and store.ts for durable reads and
post-commit invalidation; src/plugin.ts composition; package.json/bun.lock,
script/build.ts/check-package.ts, tsconfig.json for shipped TSX; tests and
script/qa-tui.mjs for observable behavior. Reference archive remains immutable.

Acceptance: actual host displays a DAG created through the model tool, updates
without manual reload after a node settles, displays empty/error states, opens
details and executes owner-scoped actions; disabling plugin removes the surface.
No fake PASS from CLI startup or from a tool schema alone.
