# Iolaus

Iolaus is an OpenCode 2 plugin with OMO-derived Agent prompts, explicit modes,
model-family selection, a local durable DAG runtime, and structural code tools.
Native OpenCode remains the owner of general tools, permissions, sessions, and
skill discovery; Iolaus owns its `iolaus_flow` orchestration tool and child-session
runner, the `ast_grep` and `gh` Code Mode namespaces, and the built-in
`context7` and `grep_app` remote MCP registrations.

## Boundaries

- `src/omo/` contains locally owned OMO-derived prompt code. Preserve source attribution when changing it.
- `packages/model-core/` is the locally owned copy of OMO's model-family detectors, used to pick prompt variants.
  Iolaus is config-first: it carries no requirement tables or default chains. It is a Bun workspace package
  (`@iolaus/model-core`) bundled into `dist/`. Sync it manually and record lineage in `reference/active-manifest.json`.
- `packages/ast-grep-core/` (`@iolaus/ast-grep-core`) is the locally owned copy of OMO's `ast-grep-mcp` runner,
  pattern hints and search/rewrite/scan executors, without the MCP protocol layer. It postdates the reference
  snapshot, so its manifest `source` names the upstream commit instead of a `reference/` path.
- `reference/omo/` is an immutable historical snapshot. Its instructions, manifests, tests, and runtime entrypoints are reference data, not current project configuration. Consult it when tracing a retained prompt or deliberately designing a later feature.
- Keep reference code out of imports, active tests, builds, published files, and install scripts.
- Preserve native agents and the user's default agent/model. Iolaus agent ids are the bare lane names (`sisyphus`,
  `oracle`, `quick`, `deep-high`) with title-cased display names; the only host agent Iolaus replaces is `explore`
  (registration resets its rules and marks it `iolaus.agent.replaced`). Any other id that already exists is left alone.
  Commands are `/ultrawork`, `/hyperplan`, `/team`, `/goal`, `/start-work`; the old `/iolaus-*` forms are not recognised.
- Iolaus reads config only from `IOLAUS_HOME/iolaus.json` (default `~/.iolaus/iolaus.json`).
  Legacy user/project config files and inline plugin options do not override it. Project layer `<project>/.iolaus`
  owns `plans/` and QA `evidence/`, created only when written. Shared SQLite WAL state is
  `IOLAUS_HOME/iolaus.db` (default `~/.iolaus/iolaus.db`), with DAG runs scoped to
  canonical project directories and session roles/goals global by session ID.
  Legacy per-project DAG/role/goal files and `~/.iolaus/state.db` are ignored,
  not migrated or deleted.
  `provisionHome` creates only the user directory, README and missing global config at setup and never overwrites; every rendered prompt ends with
  `<iolaus-home>` naming both paths. Iolaus owns no skills directory and no memory store: skill discovery is the
  host's (`~/.agent/skills`, global skills) and cross-session memory is the user's memory plugin's (claude-mem); the
  contract says so. Never modify the host's session database outside an isolated QA sandbox.
- No automatic upstream synchronization or dependency on published OMO packages.

## Runtime

- Iolaus is written against `@opencode/plugin/effect` targeting OpenCode 2.0.27
  (`@opencode/plugin: 2.0.27`, `@opencode/schema: 2.0.27`). The entry is
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
  the Effect editor. `effect@4.0.1` is an exact peer and dependency pinned to the
  host's version and client peer contract (Effect 4.0.3 deferred), with
  `@opentui/core` and `@opentui/solid` `>=0.5.17`. Bundled builds externalize
  `effect`, `effect/*`, `@opencode/plugin`, and `@opentui/core` so runtime execution
  consumes the host's singleton instances and avoids symbol/type mismatches across packages.

- `src/dag/` is the active Iolaus durable DAG module. It uses shared SQLite WAL state,
  graph/node fingerprints, dependency-frontier admission, node-level retry,
  cancellation and JSON-safe result envelopes.
- `src/dag/observe.ts` records native `subagent` calls without changing them. The
  `execute.before` hook (registered after the role guard, so refused calls are not
  recorded) appends a node to the owner session's observed run
  (`definition.observed: true`, name "Subagent calls") via `controller.observe`; the
  child session comes from `session.created` (`parentID`) or the tool result
  (`{output: {sessionID, status, output}}`, the `<subagent …>` text or the background
  notice), and settles on the tool result or the child's
  `session.execution.succeeded|failed|interrupted`, whichever comes first. A call
  inside a child hangs under the child's node (`dependsOn` is the parent link, not
  a data edge); a follow-up by `sessionID` reopens the same node as a new attempt; a
  call the host refuses before running it fails when its caller's turn ends.
  Correlation is cached in memory and read back from the store
  (`controller.observedChild`) after a reload. A call made inside a scheduled
  `iolaus_flow` node's session (found through its `iolaus_dag_run`/`iolaus_dag_node`
  metadata and `controller.lineage`) joins the run owner's observed run, titled
  `<node> › <description>`; the scheduled run's definition is not touched. A
  reopened node keeps its last result, which the view labels with its attempt
  (`resultAttempt`). Observed runs are never scheduled: `retry`, `resume`
  and `amend` reject them. The native binding tells agents to call `subagent`
  directly for simple delegation and to use `iolaus_flow` only for data
  dependencies, retry/resume, gates or conditional branches.
- `iolaus_flow` (`FLOW_TOOL_NAME` in `src/dag/tool.ts`; formerly `iolaus_dag`, which
  `check:package` refuses in `dist/`) is the only model-facing orchestration tool in
  the first runtime slice. It is owner-scoped and schema-validated. Action `create`
  is nonblocking: it initializes the run and returns immediately while frontier
  scheduling executes in the background, keeping the owner session available for user
  interaction without forcing session switching. Calling `wait` is optional and
  blocks until terminal state (`completed`, `failed`, `cancelled`), including across
  human gates; `snapshot` and `node` inspect execution state and results on demand without blocking.
- Committed gate and terminal notices (`src/dag/notices.ts`): when a gate pauses
  for review (`node.waiting`) or a flow reaches a terminal state (`run.completed`,
  `run.failed`, `run.cancelled`), Iolaus enqueues a synthetic notice to the owner
  session via `session.synthetic` with `delivery: "queue"` and `resume: false`.
  These notices are admitted to the owner session's durable inbox without waking
  the model or triggering an unwanted continuation turn (they do not immediately
  write to persisted conversation history or claim the queued input is already consumed).
  Observed native subagent runs do not send notices.
- Live steering (`action: "steer"` in `src/dag/controller.ts`, schema in `src/dag/tool.ts`,
  runner dispatch in `src/dag/runner.ts`, authorization in `src/roles/steering.ts`):
  allows the owner session to supplement an active child task without switching sessions
  or opening child dialogs. Takes `run_id`, `node_id`, `text`, and a required durable `request_id`.
  - Execution tokens and fencing: Each execution allocates a `DagExecutionIdentity`
    (`token`, `agent`, `model`) on `DagExecutionRef` used to detect and refuse drift,
    without assuming immutable host identity or atomic pinning. Initial drift is refused
    before request creation; initial prompts are fenced until admission
    (`DagExecutionState.initial: "admitted"`). `steer` advances `inputRevision`, records a
    `DagSteerRequest` in SQLite (`state: "reserved"`), and dispatches via `runner.steer` using
    synthetic prompt delivery and verification.
  - Idempotency: `request_id` is a durable unique identifier. Reusing `request_id` with
    identical `node_id` and `text` returns the stored request without duplicate dispatch.
    Reusing the ID with differing node or text fails validation.
  - V1 limits and refusals: Targets must be active, `running` session-backed agent nodes with
    admitted initial prompts. Refuses `pending`, `starting`, `settled`, `gate`, `judge`,
    `observed` native subagent runs, planning owners, and Atlas / authorized-plan flows. Rechecks
    owner tier, role, `iolaus_flow` permission, and child `subagent` delegation permission. Child
    agent and model cannot be altered mid-flight.
  - Concurrency and failure semantics: Serialized under per-run lock and operating mutex.
    If identity drifts or delivery fails, the request is marked `unresolved`, the child session
    is cancelled, the node is interrupted, and stale results are blocked from reaching downstream
    nodes. A model failure after every supplement was delivered falls back in the same child session (see
    same-session continuation); otherwise steered executions are not retried or escalated automatically, and an
    explicit retry of a steered node is refused: re-running it needs a new flow with the complete task. Action
    `amend` refuses flows with active executions or unresolved steering, and invalidates cached outputs of steered
    nodes and their descendants.
  - Guarantees: Neither atomic identity pinning nor host-spanning exactly-once delivery is
    claimed; unconfirmed receipts or delivery ambiguities fail closed as `unresolved` rather
    than silently replaying.
- Node kinds: `agent` runs a child session; `judge` makes one `generate.text`
  call on the node's agent lane model with no session (its execution ref is
  `judge:<node>:<attempt>:<ts>`, the reply is returned by `wait`); `gate`
  waits for a human. Every template reviewer is a `judge`, so reviews cost one
  model call instead of a session.
- Runtime model fallback: a lane configured as an array in `iolaus.json` `models`
  (`laneFallbacks` in `src/models.ts`) fills `fallbackModels` on agent and judge
  nodes that omit `model`. The runner marks a failed child session, failed
  `session.create` or failed judge call as `DagRunnerError({model: true})`; that,
  or an empty reply, moves the node to the next fallback (`node.fallback`,
  `needs_retry`) until the chain is exhausted, then ordinary `maxAttempts` applies.
  Requirement chains never fall back. `fallbackModels` and the effective model
  live on the node record; Atlas authorization is checked against the planned
  node in `run.definition`, and `retry` restores the planned model.
- A `deep-low` node whose reply has the line `ESCALATE: deep-high` is rewritten
  in place to `deep-high` (lane model and fallbacks), its findings appended in
  `<iolaus-escalation>`, and rerun (`node.escalated`). Only when deep-high
  resolves to a model; admission re-checks the new agent at launch.
- Same-session continuation (`src/dag/rescue.ts`, `continueFrom` in `src/dag/runner.ts`): a session-backed
  agent node's model failure (failed child session or empty reply after its prompt was admitted) records the child
  session as `recovery.continueFrom` (SQLite `dag_node_recovery`). The next attempt, on the next fallback model or a
  remaining `maxAttempts` attempt on the last model, does not create a session: the runner waits for the child to
  stop, checks its agent and execution token, calls `session.switchModel`, re-stamps `iolaus_execution_token` and
  `iolaus_dag_attempt` with `session.update`, and queues an `<iolaus-continuation>` prompt with id
  `msg_<token>`. The task, delivered supplements and completed tool effects stay in the host's history; the host
  converts it across providers. `reattach` counts only the execution's own `msg_<token>` as its prompt. A failed
  model turn that already received every supplement is reported with `deliveredRequests`, so a steered node falls
  back in its session with the supplement delivered once. Without a continuable session (judge, failed
  `session.create`, a host without `switchModel`/`update`) a retry is a fresh session and is refused for a node
  that was ever steered. Explicit `retry`, `amend` and `cancel` drop `continueFrom`: a manual retry is a fresh
  session from the planned chain. Stock OpenCode 2.0.28 supports this; no host patch is needed.
- Owner-model rescue (`rescue: { ownerModel: boolean }` in `options.ts`, default off): after a node's fallback
  chain and attempts are spent on model failures, one more same-session continuation runs on the owner session's
  current model (`runner.ownerModel`), keeping the child's agent and permissions (`node.rescued`, a queued
  non-waking notice). One per node lifetime: `recovery.rescue` survives retry, reload, amend and removal/re-addition,
  and a spent, excluded or unavailable rescue emits `node.rescue-skipped` (`owner_rescue_spent`,
  `owner_model_already_failed`, `rescue_role_excluded`, `owner_model_unavailable`). Never for judge, gate or observed
  nodes, Atlas or `/start-work` flows, `prometheus`, planning-role owners or children, or non-model failures. A
  rescued reply is the result (no escalation rerun); provenance records `rescue: { decisionID, model, from }`; retry
  of a rescued escalated node restores `preRescueDefinition`. Live QA: `node script/qa-owner-rescue.mjs <dir>`
  (`.iolaus/evidence/owner-rescue/same-session-live`); host contract probe:
  `.iolaus/evidence/owner-rescue/same-session-probe/run3` (OpenAI→Anthropic switch on a failed session). The earlier
  fresh-session handoff design and its `session.inbox.list` host patch are superseded; their evidence directories
  are historical only.
- Worktrees (`src/dag/worktree.ts`): a run-level `directory` (absolute, a
  worktree of the project's repository by `git rev-parse --git-common-dir`,
  checked at create/amend/growth) is every child's session location; a node's
  `worktree: true` makes the runner create `<repo>-wt/iolaus-<run8>-<node>` on
  branch `iolaus/<run8>-<node>` from the run directory's HEAD, reused by retries.
  Branches outside `iolaus/<slug>` are refused. `lineage` also finds a run owned
  by another project when that run's `directory` is this project, since the
  worktree's own plugin instance serves those children.
- `/start-work <plan> [--worktree [path]] [--make-pr] [--ship]`
  (`parseStartWork`): the prompt hook creates the worktree on `iolaus/<plan>`,
  copies the git-ignored plan into it and compiles the run with that
  `directory`; `--make-pr` adds an Atlas `pr` node after `accept`, `--ship` a
  `ship` node after it. Both are authorized Atlas ticket nodes of the run.
- `team` is a DAG template and mode: split (lead) → `member<n>` worktree nodes
  → `integrate` in its own worktree → judge review → accept gate. The OMO
  `team_*` mode prompt is replaced by `TEAM_DAG_MODE_PROMPT`.
- `src/compaction.ts` hooks `session.hook("compaction")` and appends
  `<iolaus-compaction-state>` (goal, role, unfinished owned runs with open nodes)
  to the compaction request's system parts. `script/qa-borrows.mjs` is the live
  QA for fallback, escalation, team, run directories, /start-work delivery and
  compaction.
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
  specialists may call them. Upstream's
  `websearch` (host has native websearch) and `lsp` are not registered; the
  native binding maps inherited `lsp_*` names to the project's type checker,
  tests and `ast_grep`. Remote servers connect after startup, so the
  system-prompt catalog rendered for the first turn may lag; the runtime
  `search()` catalog is the authority.
- Specialist permissions follow OMO's agent catalog as per-agent deny lists on
  top of the host default (`DENIED` in `src/registration.ts`): oracle, explore
  and librarian deny `edit`, `subagent` and `iolaus_flow`; metis and momus deny
  only `edit`; multimodal-looker allows only `read`. Shell stays allowed, so
  read-only is the prompt's contract, as in OMO. Host names: `edit` covers
  edit/write/patch, `subagent` is OMO's `task`. OpenCode 2.0.27 dropped global
  `external_directory` prompts from default rules; librarian explicitly adds
  `external_directory: *` with `ask` to prompt for arbitrary external directories,
  then grants `allow` for its temporary clone root (`$TMPDIR/iolaus-gh-*`),
  preserving its clone-only boundary.
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
  comments, to the tool result. Checkers come from the global `iolaus.json` `verify`
  section (`checkers[].argv` run via execFile, no shell; `timeoutMs`; `commentPattern`
  or `null`), or, when absent, from project marker files: `tsconfig.json` → `tsc --noEmit`,
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
  `artistry`, `writing`, `unspecified-low`, `unspecified-high`), subject to the
  tier rule below. OpenCode 2.0.18 ignores `parentID` on session creation;
  the runner stores the child execution ref before prompting it and records
  metadata `iolaus_dag_node`, `iolaus_dag_attempt`, `iolaus_dag_run`.
- Agent tiers (`src/roles/tier.ts`). Three top-level workflows, four primaries
  (`PRIMARY_AGENTS`): Sisyphus, Hephaestus, Prometheus → Atlas. Every other
  Iolaus agent and category lane is a shared lower worker. Rule: a primary may
  target lower workers and its own primary (same-primary internal worker), never
  another primary; a session with a lower or foreign-primary Iolaus ancestor may
  target no primary; Atlas is a target only for a top-level Atlas `/start-work`
  create (`authorizedPlan`) or an Atlas session descended from that run's Atlas
  node. `tierSource` derives this from native host session ancestry (`parentID`)
  and DAG metadata matched to a stored execution session ID and run owner, never
  from prompt markers or models; sessions with
  no Iolaus agent in their chain are `native` and unrestricted. One check,
  `tierDenial`, gates both paths: the `execute.before` hook on `subagent` (a
  `sessionID` follow-up checks the stored and supplied agents;
  refusals are `[iolaus tier] ...`), and the controller's `admit` on the
  expanded definition at create, amend, retry, loop growth and every launch
  (owner drift after a gate fails the node; refused growth fails the run). Gates
  are exempt; `judge` nodes are not. The DAG is scheduling, not privilege.
  `/start-work` runs persist `authorizedPlan` and Atlas node fingerprints in
  `dag_authorizations`; `checkAtlas` rejects amended Atlas nodes.
- Every Iolaus Agent and category lane is registered with a pinned model. The
  model comes only from global `IOLAUS_HOME/iolaus.json` `models` (config-first, no
  built-in default chain). Iolaus does not check provider connectivity or
  subscription; a lane the config does not name is not registered. A DAG node may omit `model` to run on its lane's
  configured model.
- Restart recovery never replays a prompt. When a controller starts (plugin
  reload or restart) it reattaches every starting/running node whose child
  session already received its prompt (`runner.reattach`, no new prompt) and
  settles it with that child's own outcome, even one that finished while no
  controller listened, then continues the frontier. A node whose prompt never
  reached a child becomes `interrupted` and needs an explicit retry, which also
  returns blocked dependents to pending. `settle` is once per attempt.
  Observed (native `subagent`) runs recover the same way: a `running` node is
  waited on through its recorded session and settled with that session's
  outcome, so a reload no longer leaves "Subagent calls" running forever.
  `script/qa-dag-recover.mjs` reloads the plugin mid-run in a real TUI.
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
- `src/dag/templates.ts` expands `iolaus_flow` action `template` (or `create`
  with `template` and no `definition`) into ordinary definitions. `plan-review`:
  `plan` (prometheus) → `review` (momus judge) → `approve` gate → `execute`
  (default sisyphus). `goal-review`: `work` (default hephaestus) → `review`
  → `accept` gate. Both start with one review and carry a `loop` spec, like
  `ultrawork`: a FAIL appends `plan<n>`/`work<n>` and a fresh `review<n>` (which
  also receives the previous review) and rewires the tail (gate, executor) to it,
  up to `iterations` rounds. `reviewer`, `executor`, `gate: false`, `iterations`
  and `maxAttempts` are overrides. Templates have no tier exemption: admission
  checks the expanded nodes, overrides included. `ultrawork` fits Sisyphus,
  `goal-review` Hephaestus, `hyperplan` Prometheus; `plan-review` mixes
  Prometheus and Sisyphus, so every Iolaus primary is refused it.
- `src/roles/` owns the four primaries' roles, enforced in code. `tool.hook("execute.before")`
  resolves a policy per call (`guard.ts`): Prometheus is `planner` (writes only
  `.iolaus/plans/`, `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`; no shell; only the
  `hyperplan` template), a session a planner started is `planning` (same, plus no
  applied codemods; recorded from the `<iolaus-planning>` notice the guard appends
  to its subagent and DAG node prompts), Atlas is `atlas-unbound` (read only) until
  `/start-work` makes it `atlas-orchestrator` (operates the run, changes nothing) or it
  descends from an authorized `/start-work` Atlas node (`atlasPlan`) whose plan still
  validates, which makes it a `worker`; the `<iolaus-plan-ticket>` marker is
  informational only. Other Iolaus
  lanes are `worker` (unrestricted by role); host agents are untouched.
  Refusals are `Tool.Error`s prefixed `[iolaus <policy>]`. Session roles persist in
  `IOLAUS_HOME/iolaus.db`. `session.hook("prompt")` acts on commands only in
  top-level sessions (no `parentID`, no DAG node metadata); in a child, command text is
  plain prompt text. It switches a command's session
  to its owner (`COMMAND_OWNERS`: ultrawork → sisyphus, hyperplan → prometheus,
  goal → hephaestus, start-work → atlas; the model is kept), validates and compiles
  `/start-work <plan>` (`plan.ts`, `startwork.ts`: one Atlas node per ticket in
  `Blocked by` order, `review-standards` and `review-spec` on Momus, `fix` when
  either says FAIL, `accept` gate) and sets Hephaestus goals. The goal loop
  (`goal.ts`, after OMO's goal hook) continues a top-level Hephaestus session on
  `session.execution.succeeded` via `session.synthetic` until `update_goal`
  complete, pausing after 3 tool-less turns or 50 continuations; DAG nodes and
  subagents never loop. `get_goal`/`create_goal`/`update_goal` are denied by name to
  every Iolaus lane but Hephaestus. Hephaestus renders its GPT variant on GPT models
  and the generic GPT body elsewhere. `script/qa-roles.mjs` is the live QA.
- `ultrawork` and `hyperplan` are DAG modes (`src/prompts/mode-dag.ts`). The
  session that received `/ultrawork` or `/hyperplan` gets the OMO
  mode prompt plus an `<iolaus-mode-dag>` block telling it to `create` the
  matching template and remain available for user interaction (calling `wait`
  is optional and blocks until terminal state, including across gates); a
  paused gate is the user's decision. The
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
  distills, Prometheus plans, Momus reviews, gate. `team` runs its template. `opencode run "/<mode> ..."` resolves the command client-side, so
  the command's `execute` (and `iolaus.mode.dispatched`) is not involved; the
  context hook is what makes the mode a DAG.
- The DAG TUI (`src/tui.tsx`, dialog in `src/tui/dialog.tsx`, shared hooks in
  `src/tui/hooks.ts`) calls a run a "flow" in every label (`Flow · <name>`,
  `Iolaus Flow: show details`, child sessions `Flow · <node>`) as the tool does
  (`iolaus_flow`); the RPC id, command ids, metadata keys (`iolaus_dag_run/node/attempt`),
  prompt markers (`<iolaus-dag-child>`, `<iolaus-dag-inputs>`), trace events and
  tables keep their `dag` names. Node cards carry
  their status in the border title and are joined row to row by fork/join
  connectors (`connector` in `src/tui/view.ts`); agent replies render through
  the host's `<markdown>` with a `SyntaxStyle` built from the theme, so
  `@opentui/core` is external in the build and resolves to the host's copy.
  The TUI keeps `sidebar.content` and `sidebar.footer` read-only.
  Click a run/node or use `<leader>d` / the command palette to open a native
  details dialog. Its target-scoped keymap owns single-letter actions only
  while the dialog is focused (`c` cancels the run after the host confirm dialog); `Esc` closes it and the host restores the input
  draft/cursor. Keep the launcher in the `app` slot so it remains mounted when
  the host hides the sidebar. Register reactive keymap layers inside rendered
  components, not plugin setup. Nodes use dependency order in the dialog and
  gates-first ordering in the overview. Detail panes show dependencies, agent,
  model, attempts, approval text, errors and result excerpts, stacking on narrow
  terminals. RPC updates refresh the view and notify waiting gates without
  opening dialogs or stealing input. `script/qa-tui.mjs` drives real TUI typing,
  cursor restoration, mouse/keyboard/palette entry, narrow layout and actions.
  RPC output omits undefined fields (host validates JSON before the schema).
  Do not claim a feature as
  implemented until its runtime QA evidence exists under `.iolaus/evidence/`.

## Verification

Use Bun for development. Verify model routing, registration, configuration, native tool contracts, and shipped-copy equality. Do not test authored prose wording, section order, or length. Standard test checks include `bun test` (unit and steering regression suites), `bun run typecheck`, `bun run check:package` (build and active manifest hashes), and `bun run check:reference` (800 snapshot files).

Runtime changes require a real OpenCode session in an isolated HOME/XDG sandbox with a local mock model. Record both positive and negative cases, host-state isolation and process cleanup under `.iolaus/evidence/`. Reusable live validation is executed via `node script/qa-flow-steering.mjs <evidence-dir>`. Shipped verification evidence lives in `.iolaus/evidence/flow-steering-sdk/` (`owner-interruption-final` recording 35 checks, alongside `dependencies-live-final` and `runtime-final`), verifying nonblocking creation, live supplement delivery, child response capture, unchanged agent/model, queued non-waking terminal notices, host-state isolation, and sandbox process cleanup. Same-session fallback and owner-model rescue run on stock OpenCode 2.0.28 with no host patch: `node script/qa-owner-rescue.mjs <evidence-dir>` (evidence `.iolaus/evidence/owner-rescue/same-session-live`), host contract probe `.iolaus/evidence/owner-rescue/same-session-probe/run3`. The `host-contract/`, `upstream-inbox/` and `implementation-smoke/` directories record the superseded fresh-session handoff design and its `session.inbox.list` patch; they are historical only. Claims of live compatibility are strictly bounded to verified evidence.

Deliver changes through task-owned worktrees and pull requests. Preserve user changes and merge using merge commits after the relevant checks pass.
