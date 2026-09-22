# @oh-my-opencode/omo-opencode2

OpenCode 2 (native Effect plugin API, `@opencode/plugin@2.0.3`) adapter for
OMO. Ported from v1.

## Overview

The v2 adapter re-implements the highest-value v1 surface against the v2 plugin
API. Where v1 exports a declarative map of 14 named hook handlers, v2 registers
inside the activation Effect against typed draft-mutation APIs. The exact
Effect dependency is `4.0.0-rc.112`, matching the host SDK.

- Entry: configure the `src/` DIRECTORY, containing `index.ts`
  (a thin export of `Plugin.define({ id: "omo", effect })` in `plugin/setup.ts`). The host imports
  TypeScript directly; configured file paths are rejected. The package remains
  source-checkout-only, not part of the published npm payload.
- Trace: set `OMO_SPIKE_TRACE` to a file path to get NDJSON trace events for QA
  assertions. This is the primary observability surface; the CLI does not expose
  raw system parts or tool results.
- QA regimen: `.agents/skills/opencode2-qa/`. Port design: `.omo/plans/opencode2-port.md`.
- Pin history: `0.0.0-next-17444` → `0.0.0-beta-17793` (2026-08-21). The
  beta-17793 plugin dist is byte-identical in beta-17823 (the binary current at
  that date); QA drove 17823. Beta adds `ctx.mcp` + `ctx.storage` domains,
  `session.hook("model.request")`, `session.switchAgent`/`switchModel`/`rename`/
  `wait`, `ModelHookOptions.providerID` scoping, and a `v1/` compat subpath
  (`@opencode-ai/plugin/v1`) for v1-shaped plugins. All changes were additive;
  that earlier pin bump required zero adapter code changes.
- Current pin: `@opencode/plugin` and `@opencode/schema` 2.0.3. The package
  scope changed from `@opencode-ai`; retained Promise helpers are not the production entry. Commands
  register executable callbacks with `CommandEditor.add`, while agents retain
  their `update` method. Do not replace every domain's update based on a command
  transform error.

## Registered surface

| Surface | Count | Detail |
|---|---|---|
| Agents | 11 | 4 primaries (sisyphus default, hephaestus, prometheus, atlas) + 7 subagents, plus delegation categories as subagents |
| Tools | 11 base + 22 gated | `task`, `background_output`, `background_cancel`, `workflow`, `hashline_edit`, `todowrite`, `look_at`, `session_list`, `session_read`, `session_search`, `session_info` + 3 goal tools when `goal.enabled` + 4 monitor tools when `monitor.enabled` + 12 `team_*` tools when `team_mode.enabled` + `btw_start`/`btw_reply`/`btw_list` when `btw.enabled` |
| Hook families | 6 dirs + context composer | hashline read-enhancer, write-existing-file-guard, prometheus-md-only, comment-checker, rules-context, goal + the `session.hook("context")` composer |
| MCP servers | 3 built-ins | `context7` + `grep_app` (remote), `lsp` (local stdio) via `ctx.mcp.transform`; websearch omitted (native `ctx.websearch` exists) |
| Skills | 17 | each `shared-skills` SKILL.md parsed and added via `skill.transform` |
| Commands | builtin | slash commands via `registerBuiltinCommands` |

## Implementation invariants

These are v2-API-specific and differ from v1. Read before editing.

- **The model catalog is empty at setup time.** It populates asynchronously via
  `catalog.updated`. `createCatalogSource()` captures each update and agent model
  resolution reads `catalog.current` later; a setup-time snapshot is empty and
  silently drops every agent onto its first fallback.
- **Agent transforms are lazy.** v2 defers `agent.transform` callbacks until first
  registry materialization. Read with `yield* ctx.agent.list()` before copying
  registration sets or the base prompt. `reload()` only invalidates batched
  state; it is not a materialization barrier.
- **Prompts are baked once, patched per-request.** v2 has no config-phase prompt
  authority. The static sisyphus prompt is captured at registration via
  `onSisyphusPrompt`; the context hook locates and replaces that system part on
  every request.
- **Context injection is a single ordered composer.** v1 spreads context work
  across a 7-slot Transform tier; v2 exposes one `session.hook("context")` with
  `event.system`, `event.messages`, and `event.tools` together. Composition order
  in `hooks/register-context-hooks.ts` is load-bearing: sisyphus rebake, skill
  catalog, command catalog, rules, then keyword mode last.
- **Managed execution goes through `orchestration/execution/`.** Task, workflow,
  Team member turns, BTW and delegated look_at share one Executor. Submission
  persists a queued `RunRef` before returning; activation-scoped workers acquire
  provider/model (5), Team (4) and session (1) eligibility together. The sole
  native child prompt site is `execution/session-run.ts`, with preallocated
  session/input IDs and durable queue admission. Wait for host idle, then inspect
  the correlated outcome; neither prompt acceptance nor interrupt ACK is completion.
- **Cancellation retains capacity until drain.** Queued cancellation never creates
  a host session. Foreground timeout/interruption cancels and drains through
  `execution/foreground.ts`. `closeOwner` fences new turns and cancels queued
  turns without waiting on an approving member's own active turn. Forced Team
  deletion fences every member before draining any, preventing queued launches
  when the first active member releases capacity.
- **Persistent records do not imply automatic prompt replay.** Storage is scoped
  by host location. Terminal results remain queryable; activation drains unfinished
  started sessions and records interrupted outcomes. Queued records have no session
  to drain. A filesystem writer lock rejects competing controllers. After a crash,
  a stale `.omo/execution/<location-hash>.lock` fails closed; remove it only after
  establishing that its former host is stopped. Distributed takeover is unsupported.
- **Completion delivery has its own durable outbox.** Pending notifications recover
  across every storage page and retain stable message IDs. Managed recipients get
  another serialized Executor generation; root recipients get queued synthetic
  delivery. Failed delivery remains pending for recovery and does not turn successful
  work into failure. Distinct completions are not dropped through the idle-edge gate.
- **v2 types are readonly over mutable runtime drafts.** Core reads arrays back
  after hooks, so in-place rewrite is the expected pattern.
- **`look_at` gates on the CALLER's vision capability; v1 always delegated.**
  v2's native `read` renders images and PDFs to the model, so delegating from a
  model that can already see the file wastes a child session. The gate needs the
  caller's model, which `ToolContext` does not carry, so `session.hook("context")`
  (the only surface exposing `model` beside `sessionID`) feeds a session-to-model
  registry that the tool reads at execute time. Routes are passthrough / delegate
  / unavailable; see `tools/look-at/vision-gate.ts`.
- **The catalog lists models the user cannot call.** `catalog.provider.list()`
  covers roughly 200 providers regardless of credentials, so
  `connectedProviders` means "known to the catalog", NOT "authenticated". Any
  code choosing a model to dispatch to must not assume a catalog entry is
  callable. `selectVisionModel` therefore prefers the caller's own provider,
  which is the one provider proven to authenticate, before any tuned chain.
  Verified: a chain-first choice picked an uncallable `openai/gpt-5.6-sol` on a
  zhipuai-only account and the delegated child failed with a routing error.
- **The shell/job registry is NOT reachable from a plugin.** `ctx.shell` is
  `ShellDomain`, which is `{ hook("create.before") }` and nothing else. The full
  `ShellApi` (`list`, `create`, `get`, `timeout`, `output` with a polling
  cursor, `remove`) does exist, but it hangs off `AppApi`, the HTTP client
  surface, and the plugin `Context` never hands that client out: `ctx.app` is
  `{ name, version, channel }` metadata, `ctx.plugin` is `PluginApi` which is
  `{ list }` over PLUGINS, and `ctx.options` is freeform config with no server
  handle. Contrast `SessionDomain`, which IS `Pick<SessionApi, ...> & { hook }`;
  shell was not given the same treatment. The capability ships only as server
  routes (`GET /api/shell` = `v2.shell.list`), which need pairing and answer 401
  otherwise. Verified on `0.0.0-next-17444`; unchanged in `0.0.0-beta-17793`
  types (re-checked 2026-08-21).

  **Scope this claim carefully.** It means a plugin cannot ENUMERATE OR CONTROL
  the shells the harness itself owns. It does NOT mean a plugin cannot run
  long-lived child processes: a plugin that spawns and owns its own children is
  unaffected, which is exactly what v1's monitor does (it never touched the
  OpenCode shell registry either). An earlier revision of this file wrongly
  extended the limit to "monitor-style tools cannot be built"; that was wrong.
- **`SessionDomain` cannot list sessions or read their messages.** It is
  `Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt"
  | "generate" | "command" | "synthetic" | "interrupt" | "rename" | "move"
  | "wait" | "context">`.
  There is no `list` and no `messages`, so session-history tools cannot be built
  on `ctx.session`. opencode2 persists every session to SQLite at
  `$XDG_DATA_HOME/opencode/opencode.db` (`session_v2` plus `session_message`,
  the latter carrying an ordered `seq` and a JSON `data` payload), and
  `tools/session-manager/` reads that store directly, read-only, the same way v1
  reads OpenCode's storage. This couples to an internal schema on purpose: every
  reader degrades to a reported message instead of throwing when the shape
  changes. Verified on `0.0.0-next-17444`; the beta-17793 additions
  (`switchAgent`/`switchModel`/`rename`/`wait`) do not change this.
- **`session.hook("model.request")` cannot proactively switch models.** The event
  fires per provider dispatch, but its model field is readonly; only `baseURL?`
  and `headers` are mutable. Runtime model fallback therefore reacts to the
  durable `session.execution.failed` event and calls `session.switchModel`.
- **`aisdk` hooks only fire for models the NATIVE map cannot resolve.** The
  `aisdk.hook("sdk" | "language")` domain exists in the plugin types, but core
  resolves in `model-resolver.ts` via `AISDKNative.map()` FIRST: nine major
  packages (`@ai-sdk/anthropic`, `openai`, `openai-compatible`, `google`,
  `google-vertex`, `google-vertex/anthropic`, `azure`, `amazon-bedrock`,
  `amazon-bedrock/mantle`, `xai`) map directly to `@opencode-ai/ai/providers/*`
  and never reach `loadAISDK`, so the hooks never fire for them. Only
  unmapped minor providers fall through to the plugin-hook path (and separately,
  registration succeeds silently even when a callback will never be invoked,
  which looks identical to a silent bug). Model fallback built on this domain
  therefore covers almost nothing; `session.hook("model.request")` and
  `session.hook("http.request")` / `session.hook("http.response")` do fire and
  are the viable interception points. Verified on `0.0.0-next-17444` by tracing
  both hooks in a live session; native-map-first resolution re-verified against
  the v2 branch source (`packages/core/src/aisdk-native.ts`, read 2026-08-21).

## Goal idle continuation

Goal is default-off (`goal.enabled === true` required; `disabled_hooks`
respected). Its exclusion comes from the shared gate described under Session
dispatch, which it takes as a required `gate` dependency rather than owning.
`auto_start` (default off) creates a goal from the first main-session message.

## Todo idle continuation

A second idle injector. When the session goes idle with unfinished todos, it
injects a prompt listing them and nudging the model to continue. Default-off
(`todo_continuation.enabled === true`; `disabled_hooks` respected), and it
shares the one gate instance with goal so the two cannot both inject on one
edge. Bounded by `max_consecutive` (default 12): any drop in the remaining count
resets the budget, so a long productive run is never cut off and the bound only
bites when the model keeps going idle without finishing anything. Both
injectors are configurations of `orchestration/idle-injector.ts`: the feature
supplies the predicate, the prompt, and the trace name; the busy/idle tracking,
settle delay, post-settle re-checks and gated dispatch are shared.

## Boulder (ulw-execute) idle continuation

A third idle injector. When the session goes idle owning an active plan in
`.omo/boulder.json` with unchecked top-level tasks, it injects the next task and
nudges the model to continue the plan. Default-off (`boulder.enabled === true`;
`disabled_hooks` respected), and it shares the one gate instance with goal and
the todo enforcer. Its state is entirely on disk and re-read on every idle, so
it holds no in-memory boulder state and survives a restart. v2 runs the
single-active-work mirror mode, not v1's N-work `works` map: a session owns
work when its id is recorded (`boundVia="session"`, a resumed session) or when
the file holds exactly one active work (`boundVia="sole-active"`). More than
one active work and no recorded id returns null, the safe direction; explicit
multi-work resume is v1-only. The checklist is parsed by the harness-neutral
`@oh-my-opencode/boulder-state` core; the adapter imports it and must not fork
it.

## Session history tools

`tools/session-manager/` serves `session_list`, `session_read`, `session_search`,
and `session_info` by reading opencode2's SQLite store. Registered
unconditionally; there is no config gate.

- `db-path.ts` resolves the store: `OMO_OPENCODE2_DB`, then
  `$XDG_DATA_HOME/opencode/opencode.db`, then `~/.local/share`, then
  `%LOCALAPPDATA%` on win32. A missing store is a normal result, not an error.
- `store.ts` opens `bun:sqlite` with `{ readonly: true }` and parameterizes every
  statement. It must never gain a write path.
- `message-shape.ts` parses `session_message.data` into a typed union and falls
  back to `unknown` rather than throwing, because the schema is internal to
  opencode2 and can change between builds.
- Defaults are project-scoped: `session_list` and `session_search` filter on the
  workspace directory and skip child sessions unless asked. Search skips
  assistant reasoning, so it matches what the model actually said.

## Monitor tools

`features/monitor/` + `tools/monitor/` serve `monitor_start`, `monitor_stop`,
`monitor_list`, and `monitor_output`. Gated on `monitor.enabled` (default off);
`disabled_hooks` respects the name `monitor`.

A monitor is a watcher process the PLUGIN spawns and owns. This is why the
`ctx.shell` limit above does not block it: nothing here touches the harness shell
registry. Output is line-split, ANSI-stripped, binary-suppressed, filtered by an
optional regex, ring-buffered, and batched. Matching lines are pushed at the
model automatically; everything else stays queryable through `monitor_output`,
so a wide monitor cannot flood the context window.

- **Delivery is a queued synthetic message, not the v1 defer ladder.** v1 polled
  busy/idle, inspected the last assistant turn, deferred, retried, and deduped
  through the prompt-async gate. v2 hands the batch to the harness queue and lets
  core decide when the session accepts it, so none of that machinery is ported.
- **Delivery is deliberately NOT behind the shared dispatch gate.** See the table
  under Session dispatch. Dedupe is per batch instead, keyed
  `monitor-output:<id>:batch-<seq>`. A failed delivery removes its own key so the
  batch can be retried rather than lost.
- **Permission fails closed.** The v2 tool context has no equivalent of v1's
  bash-permission `ask`, so `monitor_start` allows only programs listed in
  `monitor.allowed_commands`, matched on argv[0]. With the list unset or empty,
  every command is refused and the refusal names the config key. Do not soften
  this into a default-allow: the tool spawns arbitrary processes and the model
  chooses the command string.
- **The untrusted-observation banner in the envelope is load-bearing.** It is
  arbitrary process output entering the model's context, and the model has to be
  told not to treat it as instructions.
- Monitors are reaped on `session.deleted` and on plugin dispose.
- The pure pipeline stages (line-stream, ring-buffer, filter, batcher, envelope)
  are a deliberate parallel implementation of v1's, not a shared core package.
  Extracting `monitor-core` would mean rewiring v1's monitor too, which pulls the
  change into the OpenCode adapter and its QA regimen for no v2 benefit. Revisit
  if a third harness needs monitors.

## Built-in MCP servers

`src/mcp/` registers three v1 built-ins through `ctx.mcp.transform` (the MCP
domain added in beta-17793): `context7` + `grep_app` (remote) and `lsp`
(local stdio). **websearch is deliberately absent**: opencode2
ships a native `ctx.websearch` domain, so a remote Exa/Tavily MCP adds nothing.

- **A user-defined server entry always wins.** The transform checks the draft
  before `set`; an existing name is deferred to the user, never overwritten.
- **`disabled_mcps` in `opencode2.json`** removes a built-in entirely.
- **Materialization must be forced.** v2 `State` defers transform application
  when registration happens inside a batch — the same laziness
  `agent.transform` shows at setup — so `registerBuiltinMcps` calls
  `await ctx.mcp.reload()` before reporting what registered. Without it the
  trace says `servers:[]` while the harness later connects them anyway.
- **Connection status is polled, not awaited.** `ctx.mcp.list()` returns
  harness-side statuses; the register function polls a few times (500ms apart)
  and traces each observation, then stops when nothing is pending.
- lsp resolution mirrors v1's `mcp/lsp.ts`: dist CLI → bun source CLI (only
  when `packages/lsp-tools-mcp/dist/cli.js` exists AND the daemon
  `package.json` is readable — the version feeds `OMO_LSP_DAEMON_VERSION`) →
  self-building bootstrap script. User config paths are v2-layout
  (`$XDG_CONFIG_HOME/opencode/lsp.json`).
- CodeGraph is user-owned only. The adapter does not resolve or register it;
  an explicit user MCP entry is preserved. Stale `[opencode2].codegraph`
  settings are stripped by the adapter schema without discarding other settings.

## Dedicated OpenCode2 configuration

The fork reads `~/.omo/opencode2.json`, with `opencode2.jsonc` as a fallback.
Project overrides use `.omo/opencode2.json` (then `.jsonc`), walked from the working
directory toward home and merged farthest-first. Home is loaded once as the user
layer. Symlinked project config files and `.omo` directories are skipped.

Settings belong at the root of this dedicated file:

```jsonc
{
  "team_mode": { "enabled": true },
  "btw": { "enabled": true },
  "monitor": { "enabled": true, "allowed_commands": ["bun"] }
}
```

Copied `[opencode2]` blocks and profiles inside the dedicated file remain supported.
Precedence remains base user/project, block user/project, selected profile base,
selected profile block, then host plugin options. Profile selection retains
`OMO_PROFILE`, `OCX_PROFILE` and the host profile-directory convention.

The v2 loader never reads or migrates `omo.json[c]` or legacy oh-my-* config files.
Those remain owned by original OMO. Missing or malformed v2 settings never fall
back to v1 settings. To migrate, copy the desired `[opencode2]` settings into the
new file and explicitly copy any formerly inherited agent overrides. Do not rename
or replace the original OMO file. The shared schema is not the schema of this file.

This separates plugin settings, not host `opencode.json` plugin lists, authentication
or project runtime state such as Team specs and boulder plans. The source installer
still configures the selected host's plugin/MCP entries; it does not create or
migrate this settings file. Restart the OpenCode2 host/server after configuration
changes, not only an attached terminal client.

If both hosts currently share a host config with incompatible plugin entries,
give OpenCode2 its own `OPENCODE_CONFIG_DIR` as well, including on the server and
when invoking the source installer. Leave the original host directory intact.
The plugin-settings filename does not change how the host finds its own config.

## BTW side conversations

`features/btw/` ports v1's BTW side conversations as tool-driven instead of
TUI-driven. This adapter does not implement a TUI entrypoint; the
capability is expressed as `btw_start` / `btw_reply` / `btw_list` tools the
model calls. Gated on `btw.enabled` in `opencode2.json` (default off);
`disabled_hooks` respects the name `btw`.

- **The BTW tag rides prompt metadata, not session metadata.** v2 `Session.Info`
  has no metadata field; `session.prompt({ metadata })` is persisted onto the
  user message by core's projector, so `getBtwMetadata` reads it back from the
  first user message of the side session on every turn.
- **Parent context comes from the SQLite store**, through the same readonly
  `SessionStore` the session-manager tools use (bounded 64KB / 64 messages,
  binary-search tail truncation, ported from v1), and is rendered INLINE into
  the side prompt (boundary sentinel + read-only transcript envelope) rather
  than spliced as real messages.
- **Delegation tools are stripped in the context hook, not blocked at
  execute time.** `registerBtwToolGuard` deletes `task` / `btw_*` /
  `monitor_start` from `event.tools` for tagged sessions — v2's idiomatic
  surface, per the plugin README.
- **Side prompts are NOT behind the shared dispatch gate.** Like
  `child-session.ts`, the plugin creates and owns the side session; each
  `btw_start`/`btw_reply` is a distinct user-initiated call, never an
  idle-edge injection. Pinned in `session-dispatch-audit.test.ts`.
- **Answers return through the shared foreground observer**, not a detached waiter
  pump. Reply checks the parent owner, and list returns the side session ID. The
  native context and execute guards deny mutation and delegation inside side
  sessions, including workflow and Team tools.

## Runtime model fallback

`features/model-fallback/` provides default-off reactive model fallback. Enable
it in `opencode2.json` with `model_fallback.enabled: true`; `max_retries`
defaults to 1 and must be at least 1. `disabled_hooks` respects the name
`model_fallback`.

- **Reactive is the only supported design.** `session.hook("model.request")`
  exposes a readonly model field, so the adapter cannot replace the model before
  a request. The event pump waits for durable `session.execution.failed`, reuses
  `@oh-my-opencode/model-core`'s provider-exhaustion classifier, and ignores
  validation, abort, context-overflow, and other non-exhaustion errors.
- **The failed main session is switched in place.** `Session.Info` exposes an
  optional model and no active agent; live CLI builds may leave that model
  absent. The feature records both active agent and model from
  `session.hook("context")` on each turn, with `Session.Info.model` as a fallback.
  It resolves the next entry with the same
  `nextFallbackModel` helper used by delegated children, calls
  `session.switchModel`, then queues a synthetic continuation so the new model
  resumes from the existing conversation.
- **The synthetic continuation uses the one plugin-wide dispatch gate.** A
  failure is an observed terminal edge, so goal, todo, boulder, and fallback
  must not race separate internal messages into the same live session. The
  fallback feature receives the gate created in `index.ts`; it never creates,
  releases, or disposes that shared gate itself.
- **Retries are bounded per session and reset on execution success.** A fallback
  attempt consumes one retry even if switching or redispatch later fails, which
  prevents a broken provider chain from looping. Exhausted chains and retry
  budgets emit trace events and stop.
- **Managed children are excluded.** Native fallback checks `Executor.managed`
  before acquiring the gate, and later activity invalidates an in-flight recovery.
  Fresh foreground task failures retain one retry through the shared model-chain
  selector, submitting the replacement through Executor for a new capacity check.

## Team Mode

`features/team-mode/` ports the first tool-driven Team Mode surface to v2. It is
default-off and requires `team_mode.enabled=true` in `opencode2.json`; `disabled_hooks`
respects the name `team_mode`. When disabled, all 12 `team_*` tools are absent.

The adapter reuses `@oh-my-opencode/team-core` for normalized/validated team
specs, registry paths, runtime state, mailbox delivery, task claiming, and task
status transitions. Project team specs are written to
`<project>/.omo/teams/{name}/config.json`, so v1 and v2 can discover the same
declared teams. Runtime/mailbox/task files use team-core's project-scoped
`<project>/.omo/runtime/{teamRunId}/` layout by setting its base directory to the
project `.omo` directory.

The 12 tools are `team_create`, `team_delete`, `team_status`, `team_list`,
`team_shutdown_request`, `team_approve_shutdown`, `team_reject_shutdown`,
`team_send_message`, `team_task_create`, `team_task_list`, `team_task_get`, and
`team_task_update`. Team creation inserts the current session as lead, then
spawns at most 4 member sessions concurrently and at most 8 total participants.
The four-member bound applies to active execution, not idle retained sessions.
Members default to the registered `sisyphus-junior` agent; a v1-compatible
`subagent_type` member overrides it, while category members run through
`sisyphus-junior` with category guidance in their initial prompt.

This first port is mailbox collaboration only. It deliberately has **no tmux
layout** and **no per-member git worktrees**; both remain follow-ups. Member
sessions are plugin-owned persistent children created by Executor. Explicit
lead-to-member messages become queued Executor message generations, preserving
session ordering and model/Team limits. A member-idle observer
that wakes the live lead with unread mailbox summaries does take the single
shared dispatch gate from `plugin/setup.ts`.

## Workflow

The explicit `workflow` tool accepts `start`, `snapshot`, `wait`, `cancel`, and
`retry`. A start contains a caller-scoped idempotency `key` and nodes with `id`,
`prompt`, registered subagent/category `agent`, `model` (`provider/model`), and
`dependsOn`. Invalid targets and graphs fail before any node is submitted.
Managed sessions cannot start nested workflows.

Dependencies control order only; node prompts are passed unchanged. A completed
dependency admits its child without waiting for an unrelated root. Failed
dependencies block descendants while independent work continues. Results and
execution references remain in snapshots for explicit consumption.

Retry requires `id`, `expected_generation` and `retry_key`; repeated keys do not
launch another generation, stale generations conflict, and completed nodes stay
unchanged. A reopened controller reconciles saved unfinished graphs against
terminal Executor records and requires explicit retry. It refuses takeover while
saved executions are still active. Cancellation batches all submitted references
under the execution mutex so queued nodes cannot start as siblings release slots.

## Session dispatch

`orchestration/session-dispatch-gate.ts` is the shared gate, v2's equivalent of
v1's `prompt-async-gate`. It reserves a session synchronously before any
`await`, compares a symbol token on release so a late release cannot free a
newer reservation, and holds the reservation for `postDispatchHoldMs` after a
dispatch so the next idle observer does not fire into a session the harness has
accepted a message for but not yet marked busy.

**One instance, created in `plugin/setup.ts`, injected into every feature that injects
on an observed edge.** This is the load-bearing part. Extracting the code is not
what prevents double injection: two instances would each admit one dispatch, so
two features would still both inject on the same edge. `createGoalRuntime` and
`registerGoalFeature` therefore take `gate` as a REQUIRED dependency with no
default, so a new feature cannot silently get its own lock. A feature's
`dispose` must not clear the gate, since that would free another feature's
reservation. Two features genuinely share the gate today (goal and the todo
enforcer); the property that one edge admits exactly one injection across both
is unit-tested in `idle-injector.test.ts` and driven on the binary in
`.omo/evidence/20260817-opencode2-todo-continuation/`.

**The gate is for N observers of ONE edge, not N distinct events.** Do not put
per-item notifications behind it. Session writes happen in exactly three places,
and only one of them belongs to the gate:

| Site | Gated | Why |
|---|---|---|
| `hooks/goal/register.ts` | yes | Idle continuation. Shares the one gate. |
| `hooks/todo-continuation/register.ts` | yes | The second idle injector. Takes the SAME gate instance goal does. |
| `hooks/boulder-continuation/register.ts` | yes | The third idle injector (ulw-execute). Same shared gate; re-reads the plan off disk on every idle. |
| `features/model-fallback/register.ts` | yes | Reactive provider-exhaustion recovery on a main-session error edge. Same shared gate; child sessions are excluded first. |
| `plugin/execution-delivery.ts` background completion | NO | Durable per-item notification; managed recipients enqueue an Executor message, roots use synthetic. Two completions must not collapse into one. |
| `orchestration/execution/session-run.ts` | NO | Single native child prompt site, protected by atomic execution admission and per-session serialization. |
| `orchestration/child-session.ts` | NO | Prompts a child session the engine created and owns, with no competing observer. |
| `commands/register-builtin-commands.ts` | NO | One prompt per explicit native command invocation, preserving inbox delivery. Distinct commands must not be dropped by the observed-edge gate. Agent-targeted commands also apply the configured agent model. |
| `features/monitor/delivery.ts` | NO | Fires once per BATCH from one monitor. Two monitors flushing in the same tick are two distinct notifications; a per-session reservation would drop one and lose output. Deduped per batch instead. |
| `features/team-mode/member-runtime.ts` | NO | Initial prompt to a plugin-owned child session. One write per spawned member, not an observed live-parent edge. |
| `features/team-mode/mailbox.ts` direct delivery | NO | One queued turn per explicit lead-to-member message; gating would drop distinct concurrent messages. |
| `features/team-mode/mailbox.ts` member-idle wake | yes | Observes a member idle edge and injects unread mailbox summaries into the live lead. Uses the same shared gate as goal/todo/boulder. |

The pinned set is enforced by `src/orchestration/session-dispatch-audit.test.ts`,
which fails the suite when any new dispatch call site or reference appears.
Update the allowlist only with justification in the commit message.
The inventory also scans retained legacy Promise helpers; presence there does not
mean the native entry calls them. Production composition is `plugin/setup.ts`.

## Conventions

- Never create a flat `foo.ts` next to an existing `foo/` directory module. Node
  resolves the file first and silently shadows the directory.
- Never `any`, `@ts-ignore`, or `@ts-expect-error`.
- Gates before commit: `bun test packages/omo-opencode2/src` (0 fail) and
  `bun run typecheck` (exit 0).
