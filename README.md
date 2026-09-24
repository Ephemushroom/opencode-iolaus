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

## Durable DAG

The `iolaus_dag` tool runs local multi-Agent DAGs with SQLite WAL state under
`.iolaus/dag/state.db`. The first runtime slice supports graph validation,
dependency-frontier scheduling, node-level retry, cancellation, restart-safe
completed state, and generation/provenance-aware result envelopes. DAG nodes use
the namespaced Iolaus Agents and native OpenCode sessions. The first DAG sidebar
is available through the `opencode-iolaus/tui` entry. Fan-in binds every
upstream result with provenance through `inputs: [{node: "*"}]`, `when`
predicates route conditionally by skipping branches, and `kind: "gate"` nodes
pause the run for a human approve/reject. Interactive panel actions are a
planned follow-up.

## Development

Run `node script/check-reference.mjs` to verify the offline source snapshot. Read `reference/README.md` for its scope and provenance.

## Independence and licensing

This repository has its own Git history and releases. It does not synchronize with, depend on published packages from, or act as an official edition of oh-my-openagent. Source attribution is retained in `NOTICE.md` and `reference/manifest.json`.

Derived OMO code remains subject to the Sustainable Use License in `LICENSE.md`. Third-party notices are preserved with the reference snapshot. This project is not affiliated with the OpenCode or oh-my-openagent maintainers.
