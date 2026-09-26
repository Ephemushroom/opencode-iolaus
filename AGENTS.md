# Iolaus

Iolaus is an OpenCode 2 plugin with OMO-derived Agent prompts, explicit modes,
model-family selection, a local durable DAG runtime, and structural code tools.
Native OpenCode remains the owner of general tools, permissions, sessions, and
skill discovery; Iolaus owns its `iolaus_dag` orchestration tool and child-session
runner, the `ast_grep` and `gh` Code Mode namespaces, and the built-in
`context7` and `grep_app` remote MCP registrations.

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
- Preserve native agents and the user's default agent/model. Iolaus agent ids are the bare lane names (`sisyphus`,
  `oracle`, `quick`, `deep-high`) with title-cased display names; the only host agent Iolaus replaces is `explore`
  (registration resets its rules and marks it `iolaus.agent.replaced`). Any other id that already exists is left alone.
  Commands are `/ultrawork`, `/hyperplan`, `/team`; the old `/iolaus-*` forms are not recognised.
- Iolaus config has two layers (`src/home.ts`). User layer `IOLAUS_HOME` (default `~/.iolaus`): `models.json`,
  `verify.json`. Project layer `<project>/.iolaus`: `dag/`, `plans/` and overrides of the same files. Project wins.
  `provisionHome` creates missing directories at setup and never overwrites; every rendered prompt ends with
  `<iolaus-home>` naming both paths. Iolaus owns no skills directory and no memory store: skill discovery is the
  host's (`~/.agent/skills`, global skills) and cross-session memory is the user's memory plugin's (claude-mem); the
  contract says so. Never modify the host's global session/config stores outside an isolated QA sandbox.
- No automatic upstream synchronization or dependency on published OMO packages.

## Runtime

- Iolaus is written against `@opencode/plugin/effect`. The entry is
  `Plugin.define({ id, effect })`; every registration (`agent.transform`,
  `command.transform`, `mcp.transform`, `tool.transform`, `session.hook`,
  `tool.hook`, `rpc.register`) is an Effect in the plugin's `Scope`, and the
  DAG controller's `close` runs as a scope finalizer. Failures are typed:
  `DagValidationError` for caller mistakes, `DagRunnerError` for child
  execution, which the scheduler turns into node retry/failure and never lets
  escape. Per-run mutual exclusion is a one-permit `Semaphore`; `wait` is a
  `Deferred`; launch fibers are forked into the controller scope so `close`
  interrupts them. `src/dag/promise.ts` is a Promise view for tests and QA;
  `src/effect-bridge.ts` lifts the Promise-authored ast_grep and gh tools into
  the Effect editor. `effect@4.0.0-rc.112` is a peer dependency pinned to the
  host's version and is external in the bundle.

- `src/dag/` is the active Iolaus durable DAG module. It uses SQLite WAL state,
  graph/node fingerprints, dependency-frontier admission, node-level retry,
  cancellation and JSON-safe result envelopes.
- `iolaus_dag` is the only model-facing orchestration tool in the first runtime
  slice. It is owner-scoped and schema-validated.
- Node kinds: `agent` runs a child session; `judge` makes one `generate.text`
  call on the node's agent lane model with no session (its execution ref is
  `judge:<node>:<attempt>:<ts>`, the reply is returned by `wait`); `gate`
  waits for a human. Every template reviewer is a `judge`, so reviews cost one
  model call instead of a session.
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
- `src/gh/` registers a read-only `gh` Code Mode namespace when a `gh` binary
  answers `--version` and `gh auth status` shows a login (`IOLAUS_GH_BIN`, then
  PATH, then common prefixes; `gh: false` disables). Twelve tools: searchCode,
  searchRepos, repo, issues, issue, prs, pr, prDiff, clone, log, blame, show.
  Every call is `execFile` with fixed argv and validated inputs (OWNER/REPO,
  ref, hex sha, relative in-repo path), no shell and no `gh api`, so no write
  subcommand is reachable. `clone` is depth-limited into `$TMPDIR/iolaus-gh-*`;
  log/blame/show accept only paths under that root. All tools carry permission
  `gh`; only librarian is allowed it, plus `external_directory` on the clone
  root so native read/grep can read clones. gh is for known repositories,
  issues, PRs and history; grep_app remains the wide regex code search.
- `src/verify/` hooks `tool.hook("execute.after")` for `edit`, `write` and
  `patch`. After a completed mutation it runs the project's checkers on the
  changed files and appends only their diagnostics, plus request-narrating
  comments, to the tool result. Checkers come from `.iolaus/verify.json`
  (`checkers[].argv` run via execFile, no shell; `timeoutMs`; `commentPattern`
  or `null`), from the plugin `verify` option as an inline object, or, when
  neither exists, from marker files: `tsconfig.json` → `tsc --noEmit`,
  `biome.json` → `biome lint --reporter=github` (else an eslint config →
  `eslint --format unix`), `pyproject.toml`/`ruff.toml` → `ruff check
  --output-format concise --no-fix`, `Cargo.toml` → `cargo check
  --message-format=short`, `go.mod` → `go vet ./...`. Output is parsed as
  `file(line,col)`, `file:line:col`, `./file:line:col` or GitHub-reporter
  `::error file=…,line=…::msg`; a checker with `format: "json"` is parsed as a
  JSON array (flat, `diagnostics`/`results`, or ESLint per-file groups). `verify: false`
  or `{checkers: [], commentPattern: null}` disables it. Hook failures never
  fail the edit. GPT model IDs get `patch` instead of `edit`/`write`; paths are
  taken from `*** Update/Add File:` headers as well as `filePath`/`path`.
- DAG nodes execute through native OpenCode child sessions using the registered
  Iolaus Agent IDs: `sisyphus`, `hephaestus`, `prometheus`,
  `atlas`, the specialists, or a category lane named after the category
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
- Routing is fail-closed. `applyDefaultModels` rejects a definition at
  create/amend with `model_unavailable: no configured model for <node> (<lane>)`
  when an agent node names no `model` and its lane resolves to none; no run is
  stored. The scheduler re-scans the frontier after a skip or block settles in
  the same pass, so a node behind a skipped branch is not left pending.
- `src/dag/templates.ts` expands `iolaus_dag` action `template` (or `create`
  with `template` and no `definition`) into ordinary definitions. `plan-review`:
  `plan` (prometheus) → `review` (momus) → `revise` when the review
  ends `VERDICT: FAIL` → `rereview` → `approve` gate → `execute` (default
  sisyphus). `goal-review`: `work` (default hephaestus) → `review`
  → `fix` → `rereview` → `accept` gate. `reviewer`, `executor`, `gate: false`
  and `maxAttempts` are overrides. The four primaries orchestrate through the
  same tool, so templates are the shared shape, not agent-specific prompts.
- `ultrawork` and `hyperplan` are DAG modes (`src/prompts/mode-dag.ts`). The
  session that received `/ultrawork` or `/hyperplan` gets the OMO
  mode prompt plus an `<iolaus-mode-dag>` block telling it to `create` the
  matching template and `wait`; a paused gate is the user's decision. The
  `ultrawork` template unrolls the loop as `work` → `review` → `fix<n>` →
  `review<n>` guarded by the previous verdict (up to `iterations`, default 3),
  then an `accept` gate; worker prompts carry the ultrawork marker plus
  `<iolaus-dag-child>`, which suppresses the DAG block so a child does the work
  instead of spawning another run. The loop is dynamic (`src/dag/loop.ts`): the
  template creates `work` → `review` → `accept` plus a `loop` spec, and when the
  newest review settles with `VERDICT: FAIL` and rounds remain the scheduler
  appends `work<n>` / `review<n>` (event `loop.grown`, generation +1) and
  rewires the tail gate to the newest review. `iterations` is the round cap. `hyperplan` fans `members` (default the
  four category lanes) through analyse → cross-attack → defend, then Metis
  distills, Prometheus plans, Momus reviews, gate. `team` remains a prompt-only
  mode. `opencode run "/<mode> ..."` resolves the command client-side, so
  the command's `execute` (and `iolaus.mode.dispatched`) is not involved; the
  context hook is what makes the mode a DAG.
- The DAG TUI (`src/tui.tsx`, pure helpers in `src/tui/view.ts`) claims
  `sidebar.content` and `sidebar.footer`. Per run: coloured status glyphs from
  the host theme, a progress bar, generation and age; nodes ordered gates →
  running → rest, indented by dependency depth, with `⚖` for judges and `⏸`
  for gates. A waiting gate shows its prompt; a running node shows the latest
  assistant text of its child session (`context.data.session.message`). A
  keymap layer (active only when runs exist) binds `j`/`k` select, `o` open
  the selected node's child session (`ui.tabs.focus`, else
  `ui.router.navigate({type:"session"})`), `a` approve, `r` reject, plus
  palette-only retry and cancel; mouse down selects, mouse up on the selected
  row opens. `node.waiting` events call `attention.notify`. The footer shows a
  one-line summary. RPC output omits undefined fields (host validates JSON
  before the schema). `script/qa-tui.mjs` drives the real TUI in tmux with a
  mock model, captures screens, presses the keys and asserts trace
  `iolaus.tui.action` / `iolaus.tui.open`. Do not claim a feature as
  implemented until its runtime QA evidence exists under `.omo/evidence/`.

## Verification

Use Bun for development. Verify model routing, registration, configuration, native tool contracts, and shipped-copy equality. Do not test authored prose wording, section order, or length.

Runtime changes require a real OpenCode session in an isolated HOME/XDG sandbox with a local mock model. Record both positive and negative cases, host-state isolation and process cleanup under `.omo/evidence/`. Unit tests alone do not establish live compatibility.

Deliver changes through task-owned worktrees and pull requests. Preserve user changes and merge using merge commits after the relevant checks pass.
