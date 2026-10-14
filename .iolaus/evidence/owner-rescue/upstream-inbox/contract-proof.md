# Isolated Plugin Inbox Contract Proof

HOST_CONTRACT: PASS

The final source-host run used PID `4464` and session
`ses_ecb7d486fffeW0XwSKJD1irwoW`. Both plugin instances changed across reload;
all four pending items remained identical. Provider traffic stayed at three
HTTP requests (one rejected transport GET and two failed model POSTs), with no
additional requests from reads or reload. The server and mock are stopped,
zero mock sockets remain, and the sandbox is removed.

This evidence concerns only the read-only `session.inbox.list` exposure in an
isolated OpenCode source checkout. It does not implement or validate Iolaus
owner-model rescue, and does not change the installed OpenCode host.

## Source And Patch

- Official tag: `v2.0.27`.
- Exact source SHA: `1f4d07a4a519185955ae8ab2ea3607805509e386`.
- Existing branch: `plugin-inbox-read`.
- Checkout: `/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/owner-rescue-opencode-2.0.27`.
- Complete patch, including the untracked regression test: `upstream.patch`.
- Source, lockfile, patch hashes and tool versions: `source.json`.

The five preserved tracked-file changes add eleven lines. Four expose `list`
through the Effect/Promise session types, core plugin host and Promise adapter;
the fifth updates the existing test fixture. The new 59-line regression test
exercises both plugin APIs, including exact `keyof inbox = "list"` type checks.
No protocol, generated client, mutation API, or session execution code changes.
The Promise adapter already unwraps single-`data` endpoint envelopes; the core
mapping correctly returns the existing session service's array directly.

## Reproduce

Run from the Iolaus worktree, with the existing isolated source dependencies:

```sh
python3 .iolaus/evidence/owner-rescue/upstream-inbox/checks.py
python3 .iolaus/evidence/owner-rescue/upstream-inbox/lifecycle.py
```

For just the live contract probe:

```sh
node .iolaus/evidence/owner-rescue/upstream-inbox/probe.mjs
```

`QA_OPENCODE_SOURCE` can override the checkout location. The probe creates a
fresh marked sandbox beneath the approved temporary directory and launches:

```sh
patched-opencode.sh serve --hostname 127.0.0.1 --port 0
```

The launcher requires `QA_SANDBOX`, matching `HOME`/`OPENCODE_TEST_HOME`, and
isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`,
and `IOLAUS_HOME`. The probe supplies a clean environment, a local mock provider
and the exact launch parameters recorded in `live/receipt.json`. It invokes
the absolute source CLI with its explicit Solid preload and tsconfig, so it
works from the sandbox project rather than relying on a source-directory CWD.
The source CLI reports `opencode vlocal`; its identity is the verified tag SHA
plus the recorded patch, not a falsely relabeled release binary.

## Static And Unit Evidence

`commands.json` contains actual commands, working directories and exit codes.

- `red-baseline.log`: both tests fail on the unmodified tag because `inbox` is absent.
- `core-focused.log`: six session plugin tests pass, 29 assertions.
- `core-plugin-tests.log`: 416 tests pass, 1,738 assertions.
- `plugin-tests.log`: nine tests pass.
- `plugin-typecheck.log` and `core-typecheck.log`: both package typechecks pass.
- `plugin-build.log` and `core-build.log`: both package builds pass.
- `root-check.log`: canonical `bun run check` succeeds; 36 typecheck tasks succeed.
- Root lint reports 1,487 existing warnings and zero errors; none concern the changed files.

The red check extracts a disposable pristine archive, links existing dependency
artifacts with workspace links redirected into that archive, and copies only
the new test into it. It never reverses the user's patch. The archive and check
HOME/XDG sandbox are removed, recorded in `checks-cleanup.json`. Dependencies
were reused; no new install, vendored monorepo, commit, push or PR was made.

## Live Contract And Lifecycle Evidence

The authoritative live result is `live/assertions.json`; full HTTP requests,
responses, plugin instance IDs, source SHA, provider HTTP request counts and environment
are in `live/receipt.json`. `live-commands.json` records the positive probe,
intentional failure probes and launcher refusals with their actual exit codes.

The live test exercises Effect and Promise plugins through their real context
API, called over correctly location-scoped HTTP RPC (`location[directory]`).
It verifies empty inbox reads, pending synthetic/user/compaction/move items after
provider failure, equality with the public inbox endpoint, repeated stable reads,
exactly the `list` method, typed missing-session refusal, and persistence after
real location/plugin reload. Per-setup instance IDs must change across reload.
Effect values use decoded `DateTime` timestamps; the Effect probe uses the
existing `SessionInbox.Info` schema encoder before comparing them with encoded
Promise/HTTP values. This preserves full-value equality rather than discarding
timestamps or changing the actual API's types.
Context and outcome stay unchanged, all four queue items remain present, and
the mock provider call count must not increase during reads or reload.

An important existing host behavior: `compact` and `move` always schedule a wake,
even with `delivery: "queue"`; they do not accept `resume: false`. To construct a
valid pending-control fixture without changing the host, the local mock holds
the first model request while controls are queued behind a disposable synthetic
input. Releasing HTTP 401 causes that request and the coalesced wake's disposable
input to fail. The controls remain pending. The required synthetic and user input
are then admitted with `resume: false`. No-wake assertions begin after this setup.
The test does not claim that admitting compaction/move is a read-only operation.

Both deliberate failures (`failure-partial-setup`, `failure-spawn`) must exit 1,
record `FAIL`, emit no PASS token, and still stop the mock/process group, remove
the sandbox and preserve the real configuration/install hashes. Launcher
refusals are tested before any state-directory creation. Cleanup stages collect
their own failures and run independently, including log collection versus removal.

Earlier failed probe receipts are preserved in `failure-launcher-preload`,
`failure-spawn-before-preload-fix`, `failure-probe-dependencies`, and
`failure-control-wake-assumption`, and `failure-effect-date-encoding`. These are harness discoveries, not passing
contract evidence. The final `live` artifacts supersede them.
The date-encoding failure also exposed an upgraded mock socket that could keep
the probe process alive after server cleanup. That owned probe was terminated;
the final mock tracks and destroys every socket, including upgraded connections,
and both successful and failing probes now exit on their own.

## Limits

This is a point-in-time read API, not atomic read-and-transfer, an inbox lock,
or an exactly-once guarantee. Real configuration and installed-binary SHA-256
hashes are compared before/after; the live host session database is neither
opened nor modified by these probes. Private servers are stopped after QA.
The launcher and source checkout remain for the next authorized isolated test.
Iolaus runtime and active documentation changes are outside this task.
