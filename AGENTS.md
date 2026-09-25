# Iolaus

Iolaus is an OpenCode 2 plugin with OMO-derived Agent prompts, explicit modes,
model-family selection, a local durable DAG runtime, and structural code tools.
Native OpenCode remains the owner of general tools, permissions, sessions, and
skill discovery; Iolaus owns its `iolaus_dag` orchestration tool and child-session
runner, the `ast_grep` Code Mode namespace, and the built-in `context7` and
`grep_app` remote MCP registrations.

## Boundaries

- `src/omo/` contains locally owned OMO-derived prompt code. Preserve source attribution when changing it.
- `packages/model-core/` is the locally owned copy of OMO's model-core subset: the agent and category model
  requirement tables, the resolution pipeline and the model-family detectors. It is a Bun workspace package
  (`@iolaus/model-core`) bundled into `dist/`. Sync it manually and record lineage in `reference/active-manifest.json`.
- `packages/ast-grep-core/` (`@iolaus/ast-grep-core`) is the locally owned copy of OMO's `ast-grep-mcp` runner,
  pattern hints and search/rewrite/scan executors, without the MCP protocol layer. It postdates the reference
  snapshot, so its manifest `source` names the upstream commit instead of a `reference/` path.
- `reference/omo/` is an immutable historical snapshot. Its instructions, manifests, tests, and runtime entrypoints are reference data, not current project configuration. Consult it when tracing a retained prompt or deliberately designing a later feature.
- Keep reference code out of imports, active tests, builds, published files, and install scripts.
- Preserve native agents and the user's default agent/model. Namespace Iolaus registrations.
- Persist Iolaus DAG state only under `.iolaus/`; never modify the host's global session/config stores outside an isolated QA sandbox.
- No automatic upstream synchronization or dependency on published OMO packages.

## Runtime

- `src/dag/` is the active Iolaus durable DAG module. It uses SQLite WAL state,
  graph/node fingerprints, dependency-frontier admission, node-level retry,
  cancellation and JSON-safe result envelopes.
- `iolaus_dag` is the only model-facing orchestration tool in the first runtime
  slice. It is owner-scoped and schema-validated.
- `src/ast-grep/` registers `ast_grep.search`, `ast_grep.rewrite` and
  `ast_grep.scan` as Code Mode tools when an `ast-grep` binary answers
  `--version` (`IOLAUS_AST_GREP_BIN`, then PATH, then common prefixes); the
  `astGrep: false` option disables them. `search` and `scan` carry `grep`
  permission and `rewrite` carries `edit`, so the host hides them per agent.
  Plugin tools cannot raise permission prompts, so writes re-check `edit` on
  every previewed file and paths outside the session directory re-check
  `external_directory`; only an explicit `allow` passes.
- `src/mcp.ts` registers the remote MCP servers `context7`
  (`mcp.context7.com`, `CONTEXT7_API_KEY` optional) and `grep_app`
  (`mcp.grep.app`, anonymous) through `ctx.mcp.transform`, skipping any name
  the user already defines. The `mcps` option selects them; `[]` disables both.
  Their tools enter Code Mode as `tools.context7["resolve-library-id"]`,
  `tools.context7["query-docs"]` and `tools.grep_app.searchGitHub`; read-only
  specialists carry `context7_*` and `grep_app_*` allows. Upstream's
  `websearch` (host has native websearch) and `lsp` are not registered; the
  native binding maps inherited `lsp_*` names to the project's type checker,
  tests and `ast_grep`. Remote servers connect after startup, so the
  system-prompt catalog rendered for the first turn may lag; the runtime
  `search()` catalog is the authority.
- DAG nodes execute through native OpenCode child sessions using the registered
  Iolaus Agent IDs: `iolaus-sisyphus`, `iolaus-hephaestus`, `iolaus-prometheus`,
  `iolaus-atlas`, the specialists, or a category lane `iolaus-<category>`
  (`quick`, `deep-low`, `deep-high`, `ultrabrain`, `visual-engineering`,
  `artistry`, `writing`, `unspecified-low`, `unspecified-high`).
- Every Iolaus Agent and category lane is registered with a pinned model. The
  model comes from `.iolaus/models.json` (user `~/.iolaus/`, then project
  directories outward-in, then plugin `models` option) or, when unconfigured,
  the first entry of the OMO requirement chain. Iolaus does not check provider
  connectivity or subscription; a lane whose config and chain both name no
  model is not registered. A DAG node may omit `model` to run on its lane's
  configured model.
- Restart recovery is conservative. Already-admitted prompts are not blindly
  replayed; interrupted work requires explicit retry/resume.
- Fan-in is an ordinary Agent node binding `inputs: [{node: "*"}]`; every
  upstream result arrives with producer provenance. Conditional routing uses a
  deterministic `when` predicate over settled upstream payloads; a false
  condition marks the node `skipped` without blocking dependents. Human gates
  are `kind: "gate"` nodes that pause the run in `waiting_approval` until
  `approve`/`reject`; only the user decides a gate.
- The DAG sidebar is implemented through the `./tui` export and typed RPC
  snapshot/events, including approve/reject/cancel/retry RPC methods.
  Interactive sidebar controls are a planned follow-up. Do not claim a feature
  as implemented until its runtime QA evidence exists under `.omo/evidence/`.

## Verification

Use Bun for development. Verify model routing, registration, configuration, native tool contracts, and shipped-copy equality. Do not test authored prose wording, section order, or length.

Runtime changes require a real OpenCode session in an isolated HOME/XDG sandbox with a local mock model. Record both positive and negative cases, host-state isolation and process cleanup under `.omo/evidence/`. Unit tests alone do not establish live compatibility.

Deliver changes through task-owned worktrees and pull requests. Preserve user changes and merge using merge commits after the relevant checks pass.
