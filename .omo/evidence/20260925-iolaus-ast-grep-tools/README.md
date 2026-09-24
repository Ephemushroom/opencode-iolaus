# Iolaus ast_grep Code Mode tools

## WHAT WAS TESTED

- `packages/ast-grep-core/` ported from oh-my-openagent `dev@ed0fb0601`
  `packages/ast-grep-mcp/src`: `sg-runner`, `normalize`, `pattern-hints`,
  `tools/search`, `tools/rewrite`, `tools/scan`. The MCP protocol layer
  (`mcp.ts`, `cli.ts`) is not ported. Four files are byte-identical to upstream;
  `rewrite.ts` and `scan.ts` add a veto return on the existing
  `onPreviewComplete` seam and a `PERMISSION_DENIED` code. All six are in
  `reference/active-manifest.json` with an upstream `source`.
- `bun test` (40 tests; 10 new in `tests/ast-grep.test.ts`, 8 of them against
  the real `ast-grep` 0.45.3 binary), `bun run typecheck`, `bun run build`,
  `bun run check:reference`, `bun run check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-ast-grep-tools`.
  Three new scenarios run a real `execute` call against a two-`console.log`
  fixture. `astgrep-explore` and `astgrep-deny` drop the QA sandbox's global
  `* allow`, so the agents run on their registered permissions.

## WHAT WAS OBSERVED

- All 16 QA checks passed.
- Host probe before implementation: plugin tools with a `namespace` enter the
  Code Mode catalog by default; the host hides a tool when the agent's last rule
  for the tool's `permission` is a `* deny`; `pinned` tools always show their
  signature. Read-only specialists previously had no `execute` allow, so they
  could not reach Code Mode at all; registration now allows it.
- `astgrep-explore` (iolaus-explore, read-only): catalog header
  `ast_grep (2 tools)` with `search` and `scan` only, no `rewrite`. The model
  received `{"ok": true, "count": 2, "lines": ["src/a.ts:1", "src/a.ts:2"],
  "first": "add(1, 2)"}` computed inside one `execute` call from the structured
  result. The file was unchanged.
- `astgrep-rewrite` (build, allow-all): `ast_grep (3 tools, 2 shown)` with the
  pinned `search` and `rewrite` signatures. `apply: true` returned
  `applied: true, planned: 2`, and `src/a.ts` on disk became
  `logger.info(...)` on both lines.
- `astgrep-deny` (iolaus-prometheus, edit allowed only under `.iolaus/plans/*`):
  `rewrite` stays visible because edit is not blanket-denied; `apply: true` on
  `src/` returned `PERMISSION_DENIED` after the preview and before the mutation
  pass, and the file on disk was unchanged.
- Trace: `iolaus.ast_grep.registered` with `/opt/homebrew/bin/ast-grep`, and one
  `iolaus.ast_grep.call` per scenario with agent, tool, ok, code and match count.
- Earlier scenarios are unchanged. Host state isolation, process cleanup and
  mock protocol checks passed.

## WHY IT IS ENOUGH

Visibility is enforced by the host from each tool's `permission`; the live runs
prove both sides (explore cannot see `rewrite`, a writer can). Because plugin
tools run in-process and cannot raise permission prompts, writes re-check the
agent's `edit` rules on every previewed file and outside paths re-check
`external_directory`, allowing only an explicit `allow`; unit tests cover the
planner split (plans allowed, src denied), `ask` treated as deny, and external
paths, and the live deny scenario proves the gate runs before any write.
