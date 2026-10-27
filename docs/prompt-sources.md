# Prompt sources

Where each Iolaus prompt rule comes from, and where to look when changing one. This is the reference `prompt-design.md` §8 ("read the vendor's current guidance for the model class before touching its prompt") points at.

Two kinds of sources matter:

1. **Vendor prompting guides** — the official docs each vendor publishes for a model family. A rule in an Iolaus prompt should trace to one of these, or to a measured failure this harness observed. Carrying a rule across generations without checking the new guide is how a 5.0 counter becomes a 5.5 overshoot.
2. **Harness system prompts** — the leaked/published prompts from real shipping harnesses (Claude Code, Codex, Cursor, etc.). Iolaus is itself an orchestration harness, so its prompt shape, section ordering, and the kinds of rules worth writing are informed by how other harnesses structure theirs. This is design reference, not text to copy: a harness prompt is tuned to its host's tools, permissions, and session model, and Iolaus has its own.

## 1. Vendor prompting guides

Read the guide for the model class before changing its prompt. A rule that helped on the previous generation may be the one that hurts on the new one.

### Anthropic (Opus, Fable/Mythos, Sonnet, Haiku)

| Document | URL |
| --- | --- |
| Prompting overview (all models) | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview |
| Prompting best practices (cross-model) | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| **Prompting Claude Opus 5** | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 |
| **Prompting Claude Opus 5.5** | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 |
| Effort (Opus 5.5 default is `medium`) | https://platform.claude.com/docs/en/build-with-claude/effort |
| Thinking (always on for 5.5, optional for 5.0) | https://platform.claude.com/docs/en/build-with-claude/thinking |
| Refusals and fallback (`reasoning_extraction`, etc.) | https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback |
| Migration guide (Opus 5 → 5.5 breaking changes) | https://platform.claude.com/docs/en/models/opus-5-5/migration-guide |
| What's new in Opus 5.5 | https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5 |

**What the Anthropic guides give Iolaus:**
- 5.0: delegation cap ("delegate only for large, genuinely independent, parallelizable tracks"), scope constraint, over-verification removal, narration cadence, correction-narration limit. These map to `<self_knowledge>` items 2–5 and the `<communication_style>` block in `claude-opus-5.ts`.
- 5.5: thinking always on (effort is the control), the four early-stop patterns to avoid, progress updates between tool calls, "explore before you act" for loosely specified work, frontend defaults that name specific patterns, and **time signals for multiagent harnesses** (elapsed-time budgets pace parallel convergence). The 5.5 guide does **not** repeat the 5.0 delegation cap — "parallel subagents with little oversight" is listed as a 5.5 strength. This is why `claude-opus-5-5.ts` replaces 5.0's OVER-DELEGATION item with PARALLEL WORK guidance.

### OpenAI (Astra and the codenamed families)

| Document | URL |
| --- | --- |
| **Rethinking skills and prompts for GPT-6 Astra** | https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra |
| Codex / Agent SDK — subagent depth, concurrency, spend caps | https://code.claude.com/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend |

**What the OpenAI guide gives Iolaus:**
- Define completion up front (Astra stops at a first implementation and hands back).
- Persistence grant (name the work it may finish without checking in).
- Narrow boundaries (strong "ask first" language written for older models reads as a reason to pause).
- No verification pressure (Astra runs tests and self-checks).
- Less itinerary (guidance for Sol/Luna overconstrains Astra — state outcomes and decision rules, not a step list).
- No preamble instructions (asking for an intent line in an unattended run causes an early stop).

These map to the `## Completion`, `## Scope`, `## Boundaries`, and `## Verification and evidence` sections of `gpt-6-astra.ts`. The retained helpers from the GPT-5.x body (`buildKeyTriggersSection`, `buildExploreSection`, `buildLibrarianSection`) are dropped on purpose: their wording is tuned for smaller models and overconstrains Astra.

### Other carriers (Kimi, GLM, DeepSeek, Gemini, Grok)

Their retained OMO bodies are tuned for an older harness. Iolaus currently borrows the Anthropic idiom for Kimi, GLM and DeepSeek (see `prompt-design.md` §2), and keeps the retained variants for Gemini and Grok. When a vendor publishes a prompting guide for a new release, read it before splitting the carrier off into its own idiom.

## 2. Harness system prompts

Iolaus is an orchestration harness — its prompt is structured like other harness prompts, not like a chatbot system prompt. Reading how other harnesses organize theirs is how we decide what a section is worth, what a harness rule looks like vs. a model rule, and where the orchestration-specific concerns (delegation, flow, verification, completion) belong in the prompt order.

### Reference repository

**[`asgeirtj/system_prompts_leaks`](https://github.com/asgeirtj/system_prompts_leaks)** — documented system prompts from shipping harnesses. CC0-1.0 licensed. The directories relevant to Iolaus:

| Path | What it is |
| --- | --- |
| `Anthropic/claude-code/` | Claude Code (CLI/agent harness) system prompts, per model |
| `Anthropic/claude-opus-5.5.md`, `claude-opus-5.md` | claude.ai app system prompts — **not** harness prompts |
| `Anthropic/official/` | Prompts Anthropic publishes themselves (release-notes versions) |
| `OpenAI/Codex/` | Codex / GPT-6-Astra harness prompts |
| `Cursor/cursor.md` | Cursor agent system prompt |
| `Misc/amp-code.md`, `Misc/devin-cli.md`, `Misc/warp-2.0-agent.md`, `Misc/zed.md` | Other coding harness prompts |

**Important distinction:** the bare `claude-<model>.md` files at the Anthropic root are **claude.ai app** system prompts, not API prompts and not harness prompts. They show how Claude is prompted in a chat product, which is a different shape from how a coding harness prompts the same model. The harness prompts Iolaus should reference are in `Anthropic/claude-code/` and `OpenAI/Codex/`, not the root.

### What to take from harness prompts

- **Section shape**: how a harness separates identity, tool selection, delegation, verification, and completion. Iolaus's `<Role>` / `<self_knowledge>` / `<behavior_instructions>` / `<verification>` / `<Iolaus_Flow>` structure is the same kind of shape — compare it to `claude-code/` to see what a harness rule looks like vs. a chatbot rule.
- **Delegation language**: how other orchestration harnesses phrase the "when to spawn a subagent" decision. Claude Code's per-model prompts show how Anthropic itself tunes the delegation cap across model releases — this is the reference for why 5.0 and 5.5 need different items.
- **What not to copy**: a harness prompt is tuned to its host's tools, permissions, and session model. Claude Code's `todowrite` tool, its permission prompt shape, its `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` caps — these are host-specific. Iolaus has its own host (OpenCode 2), its own tools (`iolaus_flow`, `ast_grep`, `gh`), and its own session model (DAG nodes in fresh sessions). Copying a rule that names a host tool Iolaus does not register is the defect `prompt-design.md` §6 warns about.

### How to use the reference

Before changing an Iolaus prompt section:
1. Read the vendor guide for the model class (§1 above) — this is the authority on what the model does.
2. Look at how the relevant harness prompt in `system_prompts_leaks` phrases the same concern — this is design reference for the shape a harness rule should take.
3. Write the rule in Iolaus's own idiom (XML for Anthropic, markdown for OpenAI) and against Iolaus's own tools (`iolaus_flow`, native `subagent`, `skill`). Do not name a tool the host does not register.
4. Add the negative assertion (`prompt-design.md` §5) so a missing tool name fails the test suite.

## 3. Iolaus prompt files

Where each rule lives in the source, for the next change:

| File | What it owns |
| --- | --- |
| `src/prompts/prompt-lanes.ts` | Model identity → lane routing (vendor → class → version) |
| `src/prompts/sisyphus-route.ts` | Sisyphus builder dispatch (table first, then idiom) |
| `src/omo/agents/sisyphus/claude-opus-5.ts` | Opus 5.0 body (delegation cap, scope, over-verification removal, narration) |
| `src/omo/agents/sisyphus/claude-opus-5-5.ts` | Opus 5.5 delta (PARALLEL WORK replaces OVER-DELEGATION, time budget, early stops) |
| `src/omo/agents/sisyphus/gpt-6-astra.ts` | GPT-6 Astra body (completion up front, persistence grant, narrow boundaries) |
| `src/omo/agents/sisyphus/default.ts` | Generic fallback body |
| `src/omo/agents/sisyphus/gemini.ts`, `grok-4.ts`, `kimi-*.ts`, `glm-5-2.ts` | Carrier-specific retained variants |
| `src/omo/agents/iolaus-flow-section.ts` | The `iolaus_flow` capability section (shared across bodies) |
| `src/prompts/native-bindings.ts` | The `<iolaus-native-contract>` appended to every rendered prompt |
| `src/omo/agents/sisyphus-dynamic-prompt-*.ts` | Shared dynamic sections (key triggers, tool selection, delegation table, etc.) |

Each file's JSDoc names the vendor guide it follows and the design decision each rule encodes. A change that does not trace back to a vendor guide or a measured failure is the kind of rule that drifts.
