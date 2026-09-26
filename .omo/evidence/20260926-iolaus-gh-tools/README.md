# Iolaus read-only gh Code Mode namespace

## WHAT WAS TESTED

- `src/gh/binary.ts`: `IOLAUS_GH_BIN` → PATH → common prefixes; a candidate
  must answer `--version`; `gh auth status` decides `authenticated`. Tools are
  registered only when authenticated (`iolaus.gh.registered` /
  `iolaus.gh.unavailable`).
- `src/gh/tools.ts`: 12 tools, all `execFile` with fixed argv, `--json`
  output where gh supports it, validated inputs (OWNER/REPO regex, ref regex,
  hex sha, relative in-repo path with no `..`), output capped at 512 KiB.
  `clone` uses `gh repo clone … -- --depth N [--branch ref]` into
  `mkdtemp($TMPDIR/iolaus-gh-)`; `log`/`blame`/`show` refuse any `clone` path
  whose realpath is not under that root. Permission `gh` on every tool.
- Registration: librarian gets `gh` allow and `external_directory` allow on
  `$TMPDIR/iolaus-gh-*`; every other read-only specialist stays denied.
- `bun test` (65 tests, 6 new in `tests/gh.test.ts`, two of them live against
  `cli/cli` with the user's gh login), typecheck, build, `check:reference`,
  `check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260926-iolaus-gh-tools`. The gh
  scenarios pass the user's `gh auth token` to the sandbox through `GH_TOKEN`
  in the environment only (sandbox HOME has no gh config); the token is
  redacted from the isolation record (`ghTokenPassed: true`).

## WHAT WAS OBSERVED

- All 26 QA checks passed.
- `gh-librarian` (read-only librarian, no global allow): catalog header
  `gh (12 tools`. One `execute` call ran `tools.gh.repo({repo: "cli/cli"})`
  → `data.name === "cli"`, `tools.gh.clone({repo: "cli/cli", depth: 2})` →
  path under `/…/T/iolaus-gh-*/cli` with `README.md` on disk, and
  `tools.gh.log` → a 40-hex sha. Traces `iolaus.gh.call` for repo (2.1 s),
  clone (9.8 s), log (13 ms), all `ok`. The QA removed the clone afterwards.
- `gh-explore` (read-only explore): no `gh (` entry in the catalog; a direct
  `tools.gh.repo(...)` inside execute threw `Unknown tool 'gh.repo'`; no
  `iolaus.gh.call` trace for explore. (`Object.keys(tools)` still lists the
  namespace name; the host hides tools, not namespace keys.)
- `gh-off` (`gh: false`): `iolaus.gh.unavailable {enabled: false}`, no gh
  tools.
- Unit tests: missing binary/override yields undefined; permission
  evaluation for librarian vs explore/oracle and the temp-root
  `external_directory` glob; argument validation rejects `a/b; rm -rf /`,
  `main; echo`, `/etc` and `$TMPDIR` as clone paths, `HEAD~1` as sha,
  `../etc/passwd` as path, all before any process runs; live repo/clone/log/
  show/blame round trip; a nonexistent repo returns `GH_ERROR` without
  throwing. `git blame --no-color` is not a valid flag; removed during testing.
- Host state isolation, process cleanup, mock protocol checks passed. Stray
  clone directories from the live unit tests were removed after the run.

## WHY IT IS ENOUGH

The live run proves the intended asymmetry: librarian can search, view, clone
and read history through gh without shell access, while explore cannot see or
call the tools. Injection is prevented structurally (no shell, fixed argv,
validated shapes) and the unit tests pin the rejected inputs.

## KNOWN LIMITS

- Live checks depend on network, the user's gh login and GitHub rate limits.
- Clones are not garbage-collected by the plugin; they live under `$TMPDIR`
  and follow the OS temp policy.
- `gh api` is intentionally absent; anything not covered by the 12 tools needs
  the user to run gh themselves.
