# Iolaus built-in remote MCP servers (context7, grep_app)

## WHAT WAS TESTED

- `src/mcp.ts` registers `context7` (`https://mcp.context7.com/mcp`, bearer
  header only when `CONTEXT7_API_KEY` is a real key) and `grep_app`
  (`https://mcp.grep.app`, anonymous) through `ctx.mcp.transform`. A name the
  user already defines is left untouched (`deferred`). Configs follow upstream
  oh-my-openagent `dev@ed0fb0601` `packages/omo-opencode/src/mcp/{context7,grep-app}.ts`,
  minus the `enabled` field OpenCode 2 does not have. Upstream's `websearch`
  and `lsp` are deliberately not registered.
- `mcps` plugin option (selection of `context7`, `grep_app`; default both).
- Read-only specialists gain `context7_*` and `grep_app_*` allows.
- `librarian-prompt.ts` now calls `tools.context7["resolve-library-id"]`,
  `tools.context7["query-docs"]`, `tools.grep_app.searchGitHub` and native
  `websearch`; `native-bindings.ts` maps inherited `server_tool` and `lsp_*`
  names for every agent.
- `bun test` (44 tests, 4 new in `tests/mcp.test.ts`), `bun run typecheck`,
  `bun run build`, `bun run check:reference`, `bun run check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-builtin-mcps`.
  Every earlier scenario now passes `mcps: []` so it stays offline. Two new
  scenarios run `iolaus-librarian` on its registered permissions (no global
  `* allow`).

## WHAT WAS OBSERVED

- All 18 QA checks passed.
- `mcps-librarian` (live network, real endpoints): trace
  `iolaus.mcp.registered {registered: [context7, grep_app], deferred: []}`.
  A single `execute` call listed `tools.context7["query-docs"]`,
  `tools.context7["resolve-library-id"]` and `tools.grep_app.searchGitHub` from
  the runtime `search()` catalog, resolved `react` to `/reactjs/react.dev`
  through context7, and got GitHub matches containing `useEffect(() => {` from
  grep_app. No permission denial occurred for the read-only librarian.
- Host behaviour learned: remote servers connect asynchronously after plugin
  setup. The Code Mode catalog embedded in the first system prompt did not yet
  list them, and early `execute` calls answered `Unknown tool
  'context7.resolve-library-id'`. The mock model retries; the tools were
  available by the fourth turn (about 6 s). `ctx.mcp.reload()` did not change
  this and is not called. The runtime `search()` catalog is the authority.
- `mcps-off` (`mcps: []`): no `iolaus.mcp.registered` trace, no `context7` or
  `grep_app` in the system-prompt catalog or in `Object.keys(tools)`
  (`["browser", "opencode", "ast_grep"]`).
- Unit tests: placeholder key `Your API Key` yields no header; a user-defined
  `context7` is preserved and only `grep_app` is registered; `mcps: ["github"]`
  is rejected; librarian evaluates `context7_query-docs` and
  `grep_app_searchGitHub` to `allow`, `shell` and `github_create_issue` to `deny`.
- Host state isolation, process cleanup and mock protocol checks passed. The
  sandbox sent only the fixed QA queries (`react` / `useEffect(() => {`) to the
  two public endpoints; no credentials were present in the sandbox environment.

## WHY IT IS ENOUGH

Registration, name deference and option handling are covered by unit tests
against a fake `MCPEditor`; the live run proves the host accepts the plugin's
config objects, connects both servers, exposes them under the expected Code
Mode paths and permission names, and that a read-only specialist can call them
end to end. The negative scenario proves `mcps: []` leaves no trace of either
namespace.

## KNOWN LIMITS

- Live scenario depends on the public endpoints and network; it is local QA,
  not CI.
- First-turn catalog lag is host behaviour; agents relying on the system-prompt
  list may need to call `search()` or retry once early in a session.
- The librarian prompt still describes `gh`/`git` shell flows that its
  read-only permissions deny; that is the separate `gh` tool-namespace follow-up.
