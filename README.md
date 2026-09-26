# Iolaus for OpenCode

Iolaus is an independently maintained OpenCode 2 plugin retaining OMO's agent prompts, mode prompts, model-family selection, and a local durable DAG for multi-Agent execution.

The original OpenCode2 adapter is preserved under `reference/omo/` for reference, including its task executor, teams, workflows, continuation hooks, and Hashline integration. Reference code is not an installable plugin or an active workspace.

## Usage

Add the package to OpenCode's V2 plugin list:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-iolaus"]
}
```

For the live DAG sidebar, add the TUI entry alongside the main plugin:

```jsonc
{
  "plugins": ["opencode-iolaus", "opencode-iolaus/tui"]
}
```

Iolaus registers namespaced agents such as `iolaus-sisyphus` and native commands such as `/iolaus-ultrawork`. It does not replace `build`, `plan`, the default model, or OpenCode's native tools. Configure `{ "enabled": false }` in the plugin object to disable it for a location.

Model routing follows configuration only. Write `.iolaus/models.json` in your home directory or in a project directory (project layers override user layers) to pin models per lane:

```json
{
  "agents": { "oracle": "openai/gpt-5.6-sol#xhigh", "sisyphus": { "model": "anthropic/claude-opus-5-5", "variant": "max" } },
  "categories": { "quick": "openai/gpt-6-luna-fast#low", "writing": "anthropic/claude-fable-5-1" }
}
```

The same object may be passed as the plugin `models` option. Lanes you do not configure use the first entry of OMO's requirement chain; a lane with no model at all is not registered. Use `agents` / `categories` options to select which lanes register.

## Durable DAG

The `iolaus_dag` tool runs local multi-Agent DAGs with SQLite WAL state under
`.iolaus/dag/state.db`. The first runtime slice supports graph validation,
dependency-frontier scheduling, node-level retry, cancellation, restart-safe
completed state, and generation/provenance-aware result envelopes. DAG nodes use
the namespaced Iolaus Agents and native OpenCode sessions. The first DAG sidebar
is available through the `opencode-iolaus/tui` entry. Every Iolaus Agent and
category lane (`iolaus-quick`, `iolaus-deep-low`, `iolaus-deep-high`, ...) runs on a
pinned model taken from `.iolaus/models.json` or, unconfigured, from OMO's
requirement chain; a DAG node may omit `model` to inherit the lane's model. Fan-in binds every
upstream result with provenance through `inputs: [{node: "*"}]`, `when`
predicates route conditionally by skipping branches, and `kind: "gate"` nodes
pause the run for a human approve/reject. Interactive panel actions are a
planned follow-up.

Two templates come built in. `{ "action": "create", "template": { "template": "plan-review", "task": "..." } }` has Prometheus write the plan, Momus review it (the reply ends `VERDICT: PASS` or `VERDICT: FAIL`), Prometheus revise on failure, Momus re-review, then pauses at a gate before the executor runs; `goal-review` does the same around Hephaestus doing the work. Use action `template` to see the expanded definition and edit it before creating. Creation is fail-closed: a node whose lane has no configured model is rejected with `model_unavailable` instead of starting a run that would fail later.

`/iolaus-ultrawork <task>` and `/iolaus-hyperplan <request>` now run as DAGs. Ultrawork loops work → review → fix → re-review until Momus passes the work, up to three rounds, then pauses at a gate for you. Hyperplan runs four category lanes through independent analysis, cross-attack and defence in parallel, has Metis distill the surviving positions, Prometheus write the plan and Momus review it. Both are also available as templates (`"template": "ultrawork"` with `iterations`, `"template": "hyperplan"` with `members`). `/iolaus-team` is unchanged.

When the `ast-grep` CLI is installed, Iolaus adds an `ast_grep` namespace to OpenCode's Code Mode: `search` (structural search with metavariable captures), `rewrite` (codemods, dry-run unless `apply: true`) and `scan` (YAML rules). Results are structured JSON with match limits and truncation reported, so an agent can filter them inside one `execute` call. Writes follow the calling agent's `edit` permission file by file; read-only specialists see only `search` and `scan`. Set `IOLAUS_AST_GREP_BIN` to pick a binary, or `{ "astGrep": false }` to turn the tools off.

Iolaus also registers two remote MCP servers from upstream OMO: `context7` (official library documentation, `https://mcp.context7.com/mcp`; set `CONTEXT7_API_KEY` for higher rate limits) and `grep_app` (regex code search across public GitHub repositories, `https://mcp.grep.app`, no account). Queries sent to those tools leave your machine. Their tools appear in Code Mode as `tools.context7[...]` and `tools.grep_app.searchGitHub`, and read-only specialists such as the librarian may call them. A server you define yourself under the same name is left untouched. Pass `{ "mcps": [] }` to register neither, or `{ "mcps": ["context7"] }` to pick one.

After every `edit`, `write` or `patch`, Iolaus verifies the changed files and appends the findings to the tool result the agent sees: type or lint errors located in those files, and comments that narrate the request instead of the code ("as requested by the user"). Without configuration a project with `tsconfig.json` gets `tsc --noEmit`. Put `.iolaus/verify.json` in the project to choose checkers, for example `{ "checkers": [{ "name": "biome", "argv": ["bunx", "biome", "check", "."], "extensions": [".ts", ".tsx"] }], "timeoutMs": 60000 }`. Commands run without a shell. Set the plugin option `"verify": false` to turn it off.

If the GitHub CLI is installed and logged in, the librarian gets a read-only `gh` namespace in Code Mode: `tools.gh.searchCode`, `searchRepos`, `repo`, `issues`, `issue`, `prs`, `pr`, `prDiff`, and `clone` (shallow, into a temporary directory) followed by `log`, `blame` and `show` on the clone. Calls run the `gh` binary directly with fixed arguments; there is no shell and no `gh api`, so nothing can write to GitHub. Set `"gh": false` to leave it out.

Iolaus keeps agent state in two layers. `~/.iolaus` (or `IOLAUS_HOME`) is shared across projects: `models.json`, `verify.json`, and `agent/plans`, `agent/memory`, `agent/skills`. `<project>/.iolaus` holds DAG state and project plans and overrides the shared files. Both are created on first run; existing files are never touched. Prompts tell agents where to write.

## Development

Run `node script/check-reference.mjs` to verify the offline source snapshot. Read `reference/README.md` for its scope and provenance.

## Independence and licensing

This repository has its own Git history and releases. It does not synchronize with, depend on published packages from, or act as an official edition of oh-my-openagent. Source attribution is retained in `NOTICE.md` and `reference/manifest.json`.

Derived OMO code remains subject to the Sustainable Use License in `LICENSE.md`. Third-party notices are preserved with the reference snapshot. This project is not affiliated with the OpenCode or oh-my-openagent maintainers.
