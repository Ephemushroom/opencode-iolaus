# Installed OpenCode 2.0.28 Compatibility

COMPATIBILITY: PASS

On 2026-10-14, the unchanged current Iolaus build passed the complete existing
35-check steering matrix on the actual installed OpenCode 2.0.28 executable,
with the `rescue` configuration property absent. This is a default-off backend
compatibility result, not a rescue-enabled or installed-plugin deployment test.

## Identity

- Executable: `/opt/homebrew/bin/opencode`.
- Resolved executable: `/opt/homebrew/Cellar/opencode-v2/2.0.28/bin/opencode`.
- Actual isolated `--version` output: `opencode v2.0.28`.
- Binary SHA-256: `7d9e936ab23af4928e0dfbf94c9fe313aac0728eef34a06709e1d86ca8987341`.
- Tested `dist/index.js` SHA-256: `effd43ee75d4702ed93ede83b1c0ddcd184b6098c1452a641ef8416fba0c1010`.
- Application version remains `0.1.0`; plugin/client/schema SDK pins remain `2.0.27`.
- Successful evidence run: `run-20261014T164740`, exit code 0, 8.056 seconds.

## Method And Results

`python3 .iolaus/evidence/owner-rescue/publication-compat/run.py` invoked the
evidence-only driver copy. `driver.diff` shows only the explicit worktree root,
exact expected host version, and evidence directory/receipt command changes.
The audit harness checks byte-for-byte equivalence after those four replacements.
The original QA driver and all application files were left unchanged.

All 35 original checks passed, including nonblocking creation, owner
interruption, live steering/idempotency, unchanged child agent/model, stale-result
fencing, queued non-waking terminal/gate notices, reload/lost-ack recovery,
cancellation, fresh unsteered retry identities, initial-admission refusal,
authorization refusal cases, identity-drift refusal, and owner interruption on
both sides of supplemental host admission. No behavioral assertion was removed,
weakened, or changed.

The local mock handled 180 requests: 176 task requests on `gpt-5.5` and four
native title-generation requests on `gpt-6-luna`. The latter use the host's title
generator instructions and are not child identity drift or rescue. An extra
post-run audit initially assumed all requests used the task model; inspection
corrected that audit classification, without changing the driver or its result.

## Isolation And Cleanup

The installed executable was used read-only. Its only CLI invocations were
`--version` and `serve --hostname 127.0.0.1 --port 0`. All HTTP requests used the
explicit URL and temporary password emitted by that private server. There were
no managed-service commands, default service discovery, real service reloads,
installed host/plugin replacements, or global configuration writes.

The child environment explicitly isolated `HOME`, `USERPROFILE`, `TMPDIR`,
`IOLAUS_HOME`, all four XDG directories, and `OPENCODE_TEST_HOME`. Auto-update and
model fetch were disabled. Credentials and other inherited environment settings
were not forwarded. The driver used only a local loopback mock provider.
Ancestor project configs and macOS managed/system configs were absent.

All database operations in the fixture targeted its isolated sandbox. The live
open-file audit found only sandbox host/Iolaus databases and their WAL/SHM files.
No real host database was read or edited by this QA work. Global configurations
were fingerprinted only; no credential contents were included in evidence.

Before/after fingerprints match for all 14 protected paths, including the
installed binary, real OpenCode/Iolaus configs, CLI/service config paths, and
currently deployed bundle files. All 213 captured source/build fingerprints also
match. The fixture reports `sandboxRemoved`, `processGone`, and `mockClosed` as
true, with empty error arrays. Independent post-run checks confirmed the outer
sandbox was removed and no matching driver/sandbox processes remained. The
server password is redacted, and the evidence credential-pattern scan is clean.

## Artifacts

- `run-20261014T164740/summary.json`: verdict, hashes, timing, and outer cleanup.
- `run-20261014T164740/matrix/receipt.json`: actual version, all 35 checks,
  isolated environment, database paths, and cleanup.
- `run-20261014T164740/matrix/assertions.json`: the complete assertion ledger.
- `run-20261014T164740/before.json` and `after.json`: hash-only fingerprints.
- `run-20261014T164740/invocation.json`: exact command and launch environment.
- `run-20261014T164740/independent-audit.json`: post-run cross-checks and sizes.
- `run-20261014T164740/stdout.log`, `stderr.log`, and `matrix/server.log`:
  captured output; stderr is empty.
- `qa-flow-steering-2.0.28.mjs`, `driver.diff`, and `run.py`: reproducible fixture.
- `matrix/requests.ndjson` under the run retains 13,742,704 bytes of raw local
  mock traffic for local audit; it need not be included in a compact publication.

## Limits

- API/backend sessions only; no direct-child TUI/screenshot reproduction or
  installed production-session validation was performed.
- The original matrix's deterministic race pauses alter only its temporary
  sandbox plugin copy, after its unmodified-build scenarios. Source, worktree
  `dist`, and deployed bundles remain untouched.
- Lost-ack tests alter only isolated Flow receipt records, not host databases;
  they are not network-loss experiments. Database open-file evidence is a
  point-in-time audit, not continuous kernel tracing.
- This result does not enable or validate owner-model rescue on stock 2.0.28,
  change SDK compatibility declarations, or replace the parent session's build
  and full regression checks.
- The first evidence-harness invocation stopped before starting OpenCode because
  local Python lacks `hashlib.file_digest`; its preflight note is preserved in
  `run-20261014T164646`. Streaming SHA-256 fixed only the local audit harness.

The JavaScript fixture passed `node --check`; the Python harness passed compile
validation; `git diff --check` passed. No commit, push, PR, or deployment occurred.
