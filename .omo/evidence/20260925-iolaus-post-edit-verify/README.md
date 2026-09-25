# Iolaus post-edit verification hook

## WHAT WAS TESTED

- `src/verify/{config,run,hook}.ts`: `tool.hook("execute.after")` on `edit`,
  `write`, `patch`, `apply_patch`. Changed paths from `filePath`/`path`/arrays
  and from apply_patch `*** Update/Add File:` headers. Checkers run through
  `execFile` (no shell) in the session directory with a timeout; stdout+stderr
  are parsed for `file(line,col)` and `file:line:col` locations and kept only
  for changed files. A comment scan flags request-narrating comments.
  The report is appended to the tool result (`content` string or array).
- Config precedence: plugin `verify` inline object, then `.iolaus/verify.json`,
  then detection (`tsc --noEmit --pretty false` when `tsconfig.json` exists).
  `verify: false` or `{checkers: [], commentPattern: null}` disables.
- `bun test` (51 tests, 7 new in `tests/verify.test.ts`), typecheck, build,
  `check:reference`, `check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-post-edit-verify`.
  Fixture project: `src/a.ts` with `const x = 1`, strict `tsconfig.json`, and
  `node_modules/.bin/tsc` symlinked to the repo's TypeScript.

## WHAT WAS OBSERVED

- All 20 QA checks passed.
- Host fact: with the QA model id `openai/gpt-5.5` the host offers `patch`
  (apply_patch) and no `edit`/`write`. The mock drives whichever is offered.
- `verify-edit` (iolaus-sisyphus): the patch changed line 1 to
  `const x: number = "one" // changed as requested by the user`. Trace
  `iolaus.verify.ran {tool: patch, paths: [src/a.ts], source: detected,
  checkers: [{tsc, ok: false, diagnostics: 1, ~330 ms}], comments: 1}`.
  The function_call_output the model received was the host's
  `Success. Updated the following files: M src/a.ts` followed by a second text
  block: `[iolaus verify] 2 issues in changed files. Fix before moving on.`,
  `tsc: src/a.ts:1 error TS2322: Type 'string' is not assignable to type
  'number'.`, `comment-check: src/a.ts:1 comment explains a request, not the
  code: ...`. File on disk holds the edit.
- `verify-off` (`verify: false`): `iolaus.verify.registered {enabled: false}`,
  no `iolaus.verify.ran`, tool result has no `[iolaus verify]` block, file
  edited normally.
- Unit tests: path extraction for edit/write/patch inputs; diagnostic filtering
  drops other files and summary lines; comment scan hits leading and trailing
  narrating comments and ignores explanatory ones; config validation rejects
  bad `argv`, unknown keys and invalid regex; a missing checker binary yields
  `could not run (ENOENT)` instead of a crash; hook ignores `read` and errored
  mutations.
- Host state isolation, process cleanup and mock protocol checks passed.

## WHY IT IS ENOUGH

The live run proves the hook fires for the tool the host actually uses, reads
the session directory, runs a real compiler, and that the model sees the
diagnostics in the same tool result as the edit. The negative run proves the
option removes the behaviour entirely.

## KNOWN LIMITS

- Detection covers TypeScript only; other stacks need `.iolaus/verify.json`.
- Diagnostics are recognised by location prefix; a checker with another output
  format contributes nothing (and is reported as ok). Test failures are not
  parsed; use a checker that prints file locations.
- Live QA used a GPT model id, so `patch` was exercised; `edit`/`write` path
  extraction is covered by unit tests only.
