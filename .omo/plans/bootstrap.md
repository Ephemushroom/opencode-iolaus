# Iolaus independent bootstrap

## Goal and binding scope

Create public Ephemushroom/opencode-iolaus as a standalone (not GitHub fork) OpenCode 2 plugin. Keep OMO Agent/mode prompt sources and model-family selection as active code. Preserve the current omo-opencode2 adapter, including task/Executor/Team/workflow/continuations/Hashline, as reference-only source. No upstream remote, sync automation, upstream package dependency or inherited publication workflow. Preserve licenses and source attribution. Source repository stays untouched.

Source: Ephemushroom/oh-my-openagent at 598cb66580bebaf39c5ea20ee4bef6cb7a906777. Local installed host: Homebrew opencode-v2/2.0.13; use matching SDK 2.0.13. Remote visibility explicitly approved: public.

## Exploration findings

- Agent builders are in packages/agents-core/src. Their only external core imports are model-family detectors (types.ts) and an optional file-URI loader (builtin-agents/resolve-file-uri.ts).
- Mode/Atlas/Prometheus text and routing live in packages/prompts-core. The loader needs frontmatter parsing; variant-resolver needs pure model-family detectors.
- Native surface currently replaces build and registers unrelated runtime capabilities; copy it for reference, create a narrow new registration layer.
- Existing task tool and shared prompts disagree about continuation identifiers and skill loading. Preserve authored text, add explicit V2 tool-binding guidance rather than carrying runtime emulation.
- Source root LICENSE.md is Sustainable Use License 1.0. Keep it and modified-copy attribution; do not advertise MIT based on stale package metadata.
- Local git only has origin; source GitHub repository is a fork. A newly created GitHub repository severs fork and synchronization relationships without rewriting source history.

## Ordered delivery units

### PR 1: reference and provenance foundation

1. Initialize sibling opencode-iolaus with an empty dev baseline, create a task-owned feature worktree before implementation, then create the public independent repository.
2. Add LICENSE.md (exact source copy), NOTICE.md (origin commit, modifications, dependency notices), README.md (scope), AGENTS.md (new scoped conventions), .gitignore, reference/README.md.
3. Preserve git-tracked packages/omo-opencode2 under reference/omo-opencode2. Preserve original Agent/mode source trees and necessary reference core source (model/team/delegate/boulder/hashline/comment-checker/rules/utils) in an offline reference archive if required for context. Historical AGENTS.md files become AGENTS.reference.md so they are evidence rather than active instructions. Record byte hashes and source/destination mapping in reference/manifest.json.
4. Add script/check-reference.ts (hash and absence checks), evidence README and machine receipt. Verify source hash completeness, no gitlinks/submodules, no upstream remotes or source workflow activation. Commit, push PR to dev, merge with merge commit after gates.

### PR 2: prompt-only native plugin

5. Add package.json (opencode-iolaus), bun.lock, tsconfig.json, bunfig.toml, script/build.ts, src/index.ts (barrel), src/plugin.ts (Plugin.define id=iolaus), src/options.ts.
6. Copy prompt-only source closure into src/omo/{agents,modes,model-family-detectors,frontmatter}; retain authored prompts; change import wiring only and remove unused file-URI barrel export. Include source lineage hashes.
7. Add src/prompts/{catalog,render,sisyphus-route,native-bindings}. Expose all retained Agent prompt families and modes. Namespace registrations, preserve native build/plan/general/explore/default model, choose prompt family from each request model, support explicit mode commands and plugin disable/agent selection options. No runtime task tools or MCP registration.
8. Add tests for model route selection, options validation, registration isolation, per-request model changes, explicit mode dispatch, native tool availability, original prompt/reference byte preservation and bundle boundaries. Tests assert behavior/metadata/equality, never authored prose wording or length.
9. Add script/qa/{host,mock,events} and script/qa-live.mjs adapted from existing tested sandbox drivers. Local mock only; fresh HOME/XDG stores and allowlisted environment. Capture positive named agent and mode cases plus disabled/native cases, actual context trace and tool schema. Verify native tool calls and host session/config isolation, record teardown receipts.
10. Add independent .github/workflows/ci.yml running install/build/typecheck/test and archive boundary checks. README documents installation, explicit modes, reference-only status, retained prompt policies and limitations. Record QA under .omo/evidence/<date>-iolaus-bootstrap/ with sanitized artifacts.
11. Review delta, run required gates, commit scoped increments only after evidence, push PR, satisfy CI/review, merge commit, sync dev and clean task-owned worktrees.

## Success criteria / stop

- Public GitHub repo reports isFork=false and only its own origin; source repo status stays clean at original commit.
- Prompt-only package builds, typechecks and passes meaningful behavior tests.
- Real OpenCode 2.0.13 loads id=iolaus; named prompt/mode selection is traced; ordinary native/disabled cases have no Iolaus prompt injection or runtime tools.
- All archived reference source hashes verify; it is absent from runtime dependency graph and package payload.
- No user OpenCode config/auth/session state is modified by QA; all spawned resources are stopped and evidence recorded.
- Both delivery PRs merged with merge commits, or a concrete external blocker documented without claiming completion.

## Execution ledger

- [x] Confirm name, active/reference boundary, public independent repository.
- [x] Inspect actual source entrypoints, imports, licenses, remotes, host version path and QA drivers.
- [x] Write plan before implementation.
- [x] Initialize independent repo and implementation worktree.
- [x] Copy source reference with complete hash manifest; preserve licensing and attribution.
- [x] Verify reference foundation and land PR 1 (800 files, CI passed, merged).
- [x] Extract prompt closure and add isolated native registration layer (verification in progress).
- [x] Verify routing/options/registration/bundle behavior (9 tests, typecheck, build, package boundary PASS).
- [x] Drive enabled/disabled native harness QA and record isolation/cleanup evidence (OpenCode 2.0.13, evidence bundle 20260922-iolaus-bootstrap-4).
- [x] Add independent CI and user documentation.
- [ ] Review, merge PR 2, sync dev and clean worktrees.

Native goal/todo tools and omo-agent-toolkit ulw-loop CLI are unavailable in this harness. This disk ledger records the same scoped goal, criteria and per-unit verification loop. One exploratory subagent failed with provider HTTP 404; continue locally rather than depending on an unavailable provider.
