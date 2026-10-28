# Flow Session Fixes

Verified against stock OpenCode 2.2.0 with a local mock model:

```sh
node script/qa-flow-session-fixes.mjs .iolaus/evidence/flow-session-fixes/revision-running-stale
```

`revision-running-stale/receipt.json` records 21 passing live checks for the revised guard. `routes.ndjson` captures the host router's actual session IDs, not only the requested navigation. Screens record the selected nodes, resulting transcripts and unavailable-session explanations. `requests.ndjson` contains only sandbox mock-model inputs and tool results.

The real plugin refused scheduler-owned Flow continuation before any observed node was created. After a successful native followup reopened its existing observed node, another refused Flow continuation left every stored node unchanged. A separate Flow failed attempt A with a mock provider error; explicit retry created B, which succeeded. A subsequent native continuation targeting A received a generic direct-child refusal, made no unverified ownership claim and left every stored node unchanged. Authorization lineage was not broadened.

Both Enter and o opened the exact native and scheduled sessions with tabs enabled and disabled. Each tabs mode additionally started a background native child and held its mock response until both Enter and o had navigated to that exact child. Screens and database assertions verify the selected node remained Running throughout those checks. Gates, judges and not-yet-started agents explained why they had no session and stayed in details.

The harness uses private HOME/XDG/IOLAUS_HOME directories and standalone servers. `receipt.json` records lsof-confirmed sandbox-only database paths for both TUI launches, unchanged production configuration hashes, no remaining sandbox processes and removal of the temporary directory. No production database was opened by the QA processes. The QA-only TUI probe records routes and provides F8 to return to the owner; it does not replace Iolaus navigation or mutate sessions.

Full checks passed with exit code 0: `tests.log`, `typecheck.log`, `package.log` and `reference.log`. The unit suite exercises actual controller fail A -> retry B, guard-before-observer refusal of A, a valid native followup control, unknown/forged metadata, unrelated parents, missing/unreadable targets, navigation errors and active/failed/interrupted/steered/foreign-owner guidance paths.

`stale-regression-red.log` is an intentional negative control: temporarily restoring the old no-lineage fallthrough made the actual-controller stale-attempt regression fail because A was accepted. The parentage check was restored immediately; the full passing suite then recorded 379 tests and 2,847 assertions.

## Historical Evidence

`verified/` and independent `owner-verification/` are retained unchanged as evidence for the earlier guard implementation. Their 16 settled-session checks do not verify the revised parentage guard, stale attempts or actively running native-child navigation. Use `revision-running-stale/` for the current implementation.

## Scope Note

An existing initial-selection race can replace a sidebar-clicked node with the waiting gate while details load. The harness explicitly selects the intended card with j/k before testing Enter/o; that independent selection issue is not changed here.
