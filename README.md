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

Iolaus registers agents under their plain names (`sisyphus`, `oracle`, `quick`) and commands `/ultrawork`, `/hyperplan`, `/team`, `/goal`, `/start-work`. The host's own `explore` agent is replaced by Iolaus's. It does not replace `build`, `plan`, the default model, or OpenCode's native tools. Configure `{ "enabled": false }` in `IOLAUS_HOME/iolaus.json` to disable it globally.

Model routing follows configuration only. Write `~/.iolaus/iolaus.json` (or `IOLAUS_HOME/iolaus.json`) to pin models per lane:

```json
{
  "models": {
    "agents": { "oracle": "openai/gpt-5.6-sol#xhigh", "sisyphus": { "model": "anthropic/claude-opus-5-5", "variant": "max" } },
    "categories": { "quick": "openai/gpt-6-luna-fast#low", "writing": "anthropic/claude-fable-5-1" }
  }
}
```

Plugin options and legacy `models.json` files are ignored. Lanes you do not configure use the first entry of OMO's requirement chain; a lane with no model at all is not registered. Use top-level `agents` / `categories` in the global file to select which lanes register.

## Three workflows

Iolaus has three top-level workflows run by four primary agents. You pick the workflow with a command; no primary hands work to another primary.

| Workflow | Primary | Command |
| --- | --- | --- |
| Do anything | Sisyphus | `/ultrawork <task>` |
| Goal loop | Hephaestus | `/goal <task>` |
| Plan, then implement | Prometheus → Atlas | `/hyperplan <request>`, then `/start-work <plan>` |

Prometheus → Atlas is one workflow with a hand-off only you make: Prometheus writes the plan and stops, and Atlas starts when you run `/start-work <plan>` and the plan validates.

Each primary has one job, and the plugin enforces it in code rather than in prompt text:

- **Sisyphus** does anything. `/ultrawork <task>` belongs to it.
- **Hephaestus** is a goal loop on any model. In a top-level session every request becomes, or updates, the session goal, and whenever Hephaestus stops while the goal is active Iolaus resumes it, up to 50 times, pausing after three turns in a row without a tool call. It ends the loop by calling `update_goal` with `complete` (or `paused` when only you can unblock it). `/goal <task>` switches to it. Goals live in `.iolaus/goals/`.
- **Prometheus** only plans. It may write `.iolaus/plans/`, `CONTEXT.md`, `CONTEXT-MAP.md` and `docs/adr/`; every other write, shell, and any template but `hyperplan` is refused, and the subagents and DAG nodes it starts run read-only too. `/hyperplan <request>` belongs to it. A plan is `.iolaus/plans/<plan>/spec.md` plus `tickets/NN-<name>.md`, each with a `**Blocked by:** None` or `**Blocked by:** 01, 02` line.
- **Atlas** only implements a plan. Until `/start-work <plan>` it can read and nothing else. `/start-work` checks the plan, then runs it as a DAG: one fresh Atlas session per ticket in blocking order, so the planning conversation never enters an implementer's context, then Momus reviews the Standards and Spec axes side by side, one fix pass runs if either fails, and an accept gate waits for you.

Running one of these commands in another agent's top-level session switches the session to the owning agent first; the session keeps its model. Commands act only in top-level sessions: in a subagent or DAG child, `/start-work` or `/goal` is ordinary prompt text.

### Who may delegate to whom

Everything that is not a primary is a shared lower worker: the specialists (`oracle`, `librarian`, `explore`, `metis`, `momus`, `multimodal-looker`, `sisyphus-junior`) and the category lanes (`quick`, `deep-low`, `deep-high`, ...). The rule is short:

- A primary may delegate to lower workers and to its own primary as an internal worker (Sisyphus to Sisyphus, Hephaestus to Hephaestus). It may not delegate to another primary.
- A lower worker, and anything below it, may not invoke any primary.
- Atlas implements only as a ticket of a `/start-work` run started from a top-level Atlas session on a valid plan. A ticket may use Atlas as its own internal worker; no other Iolaus agent can start Atlas, and an authorized ticket node cannot be amended afterwards.

The same rule covers native `subagent` calls and `iolaus_dag` nodes, including `judge` nodes; a DAG is a way to schedule work, not a way around the rule. Authority comes from native host parentage or a DAG session ID matched to its stored execution and owner, plus the stored `/start-work` authorization, never from prompt text or the model a child runs on. A `subagent` follow-up by `sessionID` checks both the stored agent and any supplied agent. A refused `subagent` call fails with `[iolaus tier] Agent tier boundary: ...`; a refused DAG is not created. Host agents such as `build` outside any Iolaus session are not restricted by this rule, but an Atlas session they start without a `/start-work` ticket stays read-only.

## Durable DAG

The `iolaus_dag` tool runs local multi-Agent DAGs with SQLite WAL state under
`.iolaus/dag/state.db`. The first runtime slice supports graph validation,
dependency-frontier scheduling, node-level retry, cancellation, restart-safe
completed state, and generation/provenance-aware result envelopes. DAG nodes use
the namespaced Iolaus Agents and native OpenCode sessions. The first DAG sidebar
is available through the `opencode-iolaus/tui` entry. Every Iolaus Agent and
category lane (`quick`, `deep-low`, `deep-high`, ...) runs on a
pinned model taken from `IOLAUS_HOME/iolaus.json` or, unconfigured, from OMO's
requirement chain; a DAG node may omit `model` to inherit the lane's model. Fan-in binds every
upstream result with provenance through `inputs: [{node: "*"}]`, `when`
predicates route conditionally by skipping branches, and `kind: "gate"` nodes
pause the run for a human approve/reject.

Native `subagent` calls stay native: follow-ups by `sessionID`, background runs and completion notices work as before. Iolaus also records each call as a node of the session's **Subagent calls** run, so the DAG view shows it with its agent, model, child session and result; calls a child makes hang under that child's node. That run is a record, not a schedule: it has no data-dependency edges and cannot be retried, resumed or amended. The agents are told to call `subagent` directly for simple delegation and to build an `iolaus_dag` definition only when the work needs dependency scheduling, retry/resume, a human gate or a conditional branch. The host allows one level of nesting unless `experimental.subagent_depth` says otherwise.

The sidebar is a read-only overview of each run's progress, colour-coded nodes and waiting approvals. Click a run or node to open its details dialog, or use `<leader>d` (normally `Ctrl+X`, then `D`) or **Iolaus DAG: show details** in the command palette. The dialog shows nodes in dependency order alongside their agent, model, dependencies, attempts, approval request, errors and result excerpts; narrow terminals stack the two panes. Only inside the dialog do `j`/`k` or arrow keys select nodes, `Enter`/`o` open an agent session, and `a`/`r` approve or reject the selected waiting gate. `PageUp`/`PageDown` scroll details; retry and cancel are clickable actions. `Esc` closes the dialog and restores the input draft and cursor. Updates never open it automatically. The footer keeps a one-line summary and a waiting gate raises a desktop notification.

Two templates come built in. `{ "action": "create", "template": { "template": "plan-review", "task": "..." } }` has Prometheus write the plan, Momus review it (the reply ends `VERDICT: PASS` or `VERDICT: FAIL`), Prometheus revise on failure, Momus re-review, then pauses at a gate before the executor runs; `goal-review` does the same around Hephaestus doing the work. Use action `template` to see the expanded definition and edit it before creating. Creation is fail-closed: a node whose lane has no configured model is rejected with `model_unavailable` instead of starting a run that would fail later.

Templates get no exemption from the delegation rule: the expanded definition, with its `executor`, `reviewer` and `members` overrides applied, is checked like any other. So `ultrawork` runs from Sisyphus, `goal-review` from Hephaestus and `hyperplan` from Prometheus, each with its own primary plus lower workers. `plan-review` puts Prometheus and Sisyphus in one graph, so every Iolaus primary is refused it; the Iolaus path from plan to implementation is `/hyperplan` followed by your `/start-work`.

`/ultrawork <task>` and `/hyperplan <request>` now run as DAGs. Ultrawork loops work → review → fix → re-review until Momus passes the work, growing the graph one round at a time up to `iterations` (default three), then pauses at a gate for you. Reviews are judge nodes: a single model call on Momus's lane, no child session. Hyperplan runs four category lanes through independent analysis, cross-attack and defence in parallel, has Metis distill the surviving positions, Prometheus write the plan and Momus review it. Both are also available as templates (`"template": "ultrawork"` with `iterations`, `"template": "hyperplan"` with `members`). `/team` is unchanged.

When the `ast-grep` CLI is installed, Iolaus adds an `ast_grep` namespace to OpenCode's Code Mode: `search` (structural search with metavariable captures), `rewrite` (codemods, dry-run unless `apply: true`) and `scan` (YAML rules). Results are structured JSON with match limits and truncation reported, so an agent can filter them inside one `execute` call. Writes follow the calling agent's `edit` permission file by file; read-only specialists see only `search` and `scan`. Set `IOLAUS_AST_GREP_BIN` to pick a binary, or set `{ "astGrep": false }` in the global `iolaus.json` to turn the tools off.

Iolaus also registers two remote MCP servers from upstream OMO: `context7` (official library documentation, `https://mcp.context7.com/mcp`; set `CONTEXT7_API_KEY` for higher rate limits) and `grep_app` (regex code search across public GitHub repositories, `https://mcp.grep.app`, no account). Queries sent to those tools leave your machine. Their tools appear in Code Mode as `tools.context7[...]` and `tools.grep_app.searchGitHub`, and read-only specialists such as the librarian may call them. A server you define yourself under the same name is left untouched. Set `{ "mcps": [] }` in the global `iolaus.json` to register neither, or `{ "mcps": ["context7"] }` to pick one.

After every `edit`, `write` or `patch`, Iolaus verifies the changed files and appends the findings to the tool result the agent sees: type or lint errors located in those files, and comments that narrate the request instead of the code ("as requested by the user"). Without configuration, checkers are detected from marker files: `tsc` for `tsconfig.json`, `biome lint` or `eslint` for their configs, `ruff check` for Python projects, `cargo check` for `Cargo.toml`, `go vet` for `go.mod`; every detected command is read-only. Checkers that print JSON can declare `"format": "json"`. Put a `"verify"` section in `IOLAUS_HOME/iolaus.json` to choose checkers, for example `{ "verify": { "checkers": [{ "name": "biome", "argv": ["bunx", "biome", "check", "."], "extensions": [".ts", ".tsx"] }], "timeoutMs": 60000 } }`. Commands run without a shell. Set global `"verify": false` to turn it off.

If the GitHub CLI is installed and logged in, the librarian gets a read-only `gh` namespace in Code Mode: `tools.gh.searchCode`, `searchRepos`, `repo`, `issues`, `issue`, `prs`, `pr`, `prDiff`, and `clone` (shallow, into a temporary directory) followed by `log`, `blame` and `show` on the clone. Calls run the `gh` binary directly with fixed arguments; there is no shell and no `gh api`, so nothing can write to GitHub. Set `"gh": false` in the global `iolaus.json` to leave it out.

Iolaus reads only `~/.iolaus/iolaus.json` (or `IOLAUS_HOME/iolaus.json`) for settings, models and verification. It provisions `{}` if missing and never overwrites an existing file; malformed or unknown settings reject plugin setup. `<project>/.iolaus` still holds project-local DAG state and plans, not configuration overrides. Skills and memory are not Iolaus features: the host discovers skills, and your memory plugin keeps memory.

## Development

Run `node script/check-reference.mjs` to verify the offline source snapshot. Read `reference/README.md` for its scope and provenance.

## Independence and licensing

This repository has its own Git history and releases. It does not synchronize with, depend on published packages from, or act as an official edition of oh-my-openagent. Source attribution is retained in `NOTICE.md` and `reference/manifest.json`.

Derived OMO code remains subject to the Sustainable Use License in `LICENSE.md`. Third-party notices are preserved with the reference snapshot. This project is not affiliated with the OpenCode or oh-my-openagent maintainers.
