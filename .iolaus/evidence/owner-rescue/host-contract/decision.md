# Owner Rescue Host-Contract Blocker

The requested backend feature is not implemented. The repository's tracked
source remains unchanged. This directory records a real OpenCode 2.0.27
counterexample to the sufficiency of the proposed continuation inspection.

## Observed Behavior

Run `node .iolaus/evidence/owner-rescue/host-contract/probe.mjs` from this
worktree. It starts a private server with isolated HOME, XDG directories,
IOLAUS_HOME, a local HTTP mock provider, and a sandbox-only diagnostic plugin.

1. A model request fails with a provider authentication error.
2. The host reports the session outcome as failed and `session.wait` returns.
3. A task-changing synthetic message is admitted with queue delivery and
   `resume: false`.
4. `session.wait` returns again. The session still reports failed. Its complete
   visible context is byte-for-byte equivalent as decoded JSON to the context
   before that admission, while the HTTP inbox API reports the pending message.
5. The queue survives a plugin reload. The newly subscribed plugin receives no
   replay of that admission.
6. The actual plugin context, not merely its declaration file, has no
   `session.inbox` property. `event` exposes only `subscribe`. `app` has no
   bound HTTP endpoint or authentication context.

See `assertions.json`, `host-context.json`, `queued-input.json`, and
`plugin.ndjson`. `server.log` has its temporary server password redacted.

## Decision

Do not interpret a failed outcome, a completed wait, a settled tool ledger, or
absence of extra transcript messages as proof that no queued input exists.
Do not ship an enabled rescue path that always refuses either, since that would
not deliver the requested opt-in feature.

The approved inspector needs an authoritative read of the source session's
pending inbox, bound to the same host instance as the plugin context, at
checkpoint capture and again before continuation admission. A supported
`ctx.session.inbox.list` capability would supply the missing read. The client
and HTTP API expose this operation, but the installed plugin context does not.
No installed-host files were changed to add it.

An independently discovered background-service client is not a transparent
replacement: plugins also run under private servers and embedded SDK hosts,
and the plugin context exposes neither a connection nor host-instance identity
with which to bind such a client. Do not guess a URL, use unauthenticated HTTP,
start another service, or bypass the host through its real database.

A durable event-ledger design is another possible amendment, but is not in the
approved design. It would need a proved completeness fence, exact handling of
all inbox kinds, gap detection, reload reconciliation, and a refusal on every
unknown interval. Merely persisting events seen by a live-only subscription
cannot establish completeness. This investigation does not certify that
alternative and does not substitute it silently.

## Verification

- `bun install --frozen-lockfile`: 369 installs checked, no changes.
- `bun test`: 342 passed, 0 failed, 1985 assertions.
- `bun run typecheck`: passed.
- `bun run check:package`: passed; build succeeded; 100 active files checked.
- `bun run check:reference`: passed; 800 reference files verified.
- `node --check .iolaus/evidence/owner-rescue/host-contract/probe.mjs`: passed.
- The live counterexample probe passed; private process group removed, temporary
  sandbox deleted, real host configuration hashes unchanged.

These are baseline and host-contract checks, not feature red/green evidence.
No rescue implementation, rescue regression tests, or successful rescue QA is
claimed. No commits, global settings, real databases, frontend, README, AGENTS,
or immutable reference files were changed.
