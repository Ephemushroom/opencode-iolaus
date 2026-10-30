# Observed Subagent Batch Grouping

Final runtime evidence: `p2-dialog/receipt.json` (PASS, OpenCode 2.2.1, ten checks, including mixed-call dialog regression). Earlier batching evidence remains in `verified/`.
Reproduce with `node script/qa-subagent-batches.mjs <directory-under-.iolaus/evidence>` after `bun run check:package`.

## Verification

- `bun test`: 382 pass, 0 fail, 2884 assertions across 25 files after the P2 dialog fix.
- `bun run typecheck`: exit 0.
- `bun run check:package`: PASS, bundled build and 91 active files checked.
- `bun run check:reference`: PASS, 800 immutable snapshot files checked.
- `git diff --check`: exit 0.
- The first regression run failed on actual controller/store output `1,10,11,12,2,...`; the final suite checks grouping, source-flow isolation, nested parent links, followups, reload, legacy preservation, unknown-identity isolation and forged metadata through real observer hooks/controllers.

## Runtime Evidence

`verified/hooks.ndjson` contains only tool/session/message IDs and delivered-context message types. It demonstrates that actual tool hooks can correlate their assistant message with the preceding delivered user request, without reading the host database. `verified/groups.json` records source keys, status, timestamps and ordered node IDs/parents.

`verified/twelve-node-details.txt` shows 1 through 12 in order. `verified/historical-label.txt` shows a failed 31-hour historical aggregate beside a fresh successful 1/1 request batch taking zero seconds. `verified/scheduled-batches.txt` and the groups receipt separate scheduled flows from observed batches. `verified/batch-details.txt`, `verified/direct-child-opened.txt` and `verified/routes.ndjson` verify exact direct-child navigation.

`p2-dialog/` reruns all prior checks against the fixed dialog. `mixed-calls-parent.txt` shows cards in recorded order `1-native-parent`, `2-grandchild`, `3-independent`, without scheduling-wave connectors, and identifies `Child calls: 2-grandchild`. `mixed-calls-child.txt` shows the next `j` selection and `Parent call: 1-native-parent`; `mixed-calls-independent.txt` shows the next `j` selection with no parent or children. `mixed-calls-child-reselected.txt` records `k` returning to the child. `mixed-calls-exact-child-opened.txt` and `routes.ndjson`, checked against the sandbox node execution session ID, verify Enter opens that exact nested child. The scheduled layout still uses the original dependency waves; the new unit regression explicitly checks scheduled ordering and layers are unchanged.

The P2 QA run passed on its first attempt. Its receipt confirms all opened database paths were inside the sandbox, real configuration hashes were unchanged, no sandbox processes remained, and the sandbox was removed.

The script uses a local mock provider and private standalone TUI instances with isolated HOME, XDG and IOLAUS_HOME. Only the sandbox Iolaus database is read/seeded with SQLite. Receipts record open database paths, unchanged real configuration hashes, sandbox removal and zero remaining sandbox processes. No real service was restarted, no global configuration changed, and no production host database was opened directly.

## Retained Attempts

- `live-initial/receipt.json`: eight initial runtime checks passed.
- `live-final/receipt.json` and `failure.txt`: harness sent the next prompt before Escape finished closing the dialog, causing keystrokes to reach dialog actions. Fixed by waiting for closure and asserting the owner route.
- `live-final-2/receipt.json` and `failure.txt`: the QA-only queue tool defaulted to Code Mode, so a native mock call could not execute it. Fixed its registration with `codemode: false`; the final run proves queued admission does not steal the current request's sequential call.

## Boundaries

Live restart validation resumes a completed native child's followup and records its new descendant in the original batch. In-flight observed recovery remains covered by the existing real-controller recovery test. Missing/compacted request identity is tested at the observer boundary and deliberately produces unique per-call batches; this run did not force live compaction. Explicit later followups intentionally retain the original clock/count rather than pretending to be new work. No speculative legacy split or migration occurs.

The mixed-call live case uses a 175-column terminal; it does not claim additional narrow-terminal coverage. The existing 12-call case still exercises wrapping. Earlier `verified/` evidence alone did not cover mixed root/child/root chronology and therefore did not close the review P2; `p2-dialog/` supplies that missing coverage.
