# OpenCode 2.0.28 Default-Off Compatibility

This evidence-only fixture checks the current Iolaus build against the installed
OpenCode 2.0.28 executable. It does not deploy a plugin or replace a host.

The copied `qa-flow-steering-2.0.28.mjs` differs from
`script/qa-flow-steering.mjs` only in:

- The root is the explicit actual Iolaus worktree, not the copy's parent.
- The expected host version is exactly `opencode v2.0.28`, independently of the
  unchanged package SDK pin `2.0.27`.
- The default evidence directory and receipt command name point to this fixture.

All behavioral assertions, mock behavior, isolated child environment, cleanup,
and sandbox-only fault injections remain identical. The fixture's Iolaus
configuration has no `rescue` property. The application version stays `0.1.0`.

`run.py` records hash-only protected-state fingerprints, invokes the copied
driver with the installed executable, saves stdout/stderr, verifies all 35
checks, and provides an outer timeout/cleanup boundary. It never opens a real
host database or issues a managed-service command. See `verification.md` and
the fresh run directory for the observed result.
