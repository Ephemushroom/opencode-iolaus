# Owner-Model Rescue Backend Verification

IMPLEMENTATION: READY

This is backend implementation evidence, not the separate full live-QA verdict.
README.md and AGENTS.md were left to the documentation owner. Pre-existing
untracked probes and upstream-host evidence were preserved.

## Checks

- `bun test`: 408 passed, 0 failed, 2,200 assertions across 22 files.
- `bun run typecheck`: exit 0.
- `bun run check:package`: exit 0, including the build and 100 active-file checks.
- `bun run check:reference`: exit 0, 800 immutable snapshot files verified.
- `git diff --check`: exit 0.
- Tests exercised red-to-green failures for global option parsing, fallback
  exhaustion before rescue, unexpected delivered input, forbidden flow/node
  flags, receipt preservation despite unsafe history, and plaintext attachments.

## Real Patched-Host Smoke

Reproduction: `node .iolaus/evidence/owner-rescue/implementation-smoke/probe.mjs`.
The probe uses the verified isolated source launcher, private HOME/XDG/IOLAUS_HOME,
the actual built Iolaus plugin and native `iolaus_flow` tool, and a local HTTP mock.

Final receipt: `receipt.json`, run `4921c8c3-0458-4a37-ad94-bbbcf481e173`.
Built `dist/index.js` SHA-256:
`a02a621dd16e6b2323302cdc85146221627ed1cca92573248b1eac081fba6961`.

- A terminal `provider.auth` failure on `openai/gpt-5.4` continued in a fresh
  child on the actual owner's `openai/gpt-5.5`, retaining agent `quick`.
- The successful result includes the rescue decision ID and source execution;
  the durable rescue record has `pinnedModel` and state `settled`.
- A second auth-failed child with queued synthetic input refused rescue with
  `pending_host_input`; the queued requirement remained present and unchanged.
- Reservation and terminal notices did not automatically wake the owner.
- Cleanup stopped the private server/process group and mock, drained all mock
  sockets, and removed the sandbox. Real config and installed binary hashes
  remained unchanged. No production session database was opened by the probe.

The probe originally needed a root `index.js` entry for this host's local plugin
discovery. The final harness supplies it. Socket-close events are awaited before
recording cleanup, so the final receipt reports zero remaining sockets.

## Contract Limits

- Stock OpenCode 2.0.27 remains unsupported when the option is enabled; default
  off is unchanged. The adapter detects actual read-only `session.inbox.list`
  capability and uses the published client's existing method type.
- The patched host's model catalog is location-local. A catalog response for a
  different child location is explicitly refused, never treated as authoritative
  for that child. No guessed cross-location API or HTTP/database bridge is used.
- Handoff inspection remains point-in-time. There is no atomic handoff or
  external exactly-once guarantee. Unsafe or unresolved history is not replayed.
- Full live coverage of steering, worktree locations, cancellation and restart
  remains the separate QA task; the behavioral suites cover those backend seams.
