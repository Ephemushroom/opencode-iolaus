# Prompt design

This is the contract the Iolaus prompts follow. It exists so that the next change is a deliberate revision of a stated rule, not an accident. Every rule below was chosen against a vendor's current guidance or a measured failure; where a rule replaced an earlier one, the history is kept so the same mistake is not reintroduced.

## 1. Route by model identity: vendor → class → version

Prompts are selected in `src/prompts/prompt-lanes.ts` from one ordered table, not from a chain of `if` statements.

- **Vendor** comes from the model name first, the provider prefix second. A reseller or gateway serves `claude-opus-4-8` under `openai/…`; the name decides the vendor, because that is what the model actually is.
- **Class** is the family: Anthropic `opus`, `sonnet`, `haiku`, `fable` (which covers `mythos`); OpenAI `astra`, `sol`, `luna`, `terra`, with a bare `gpt-<version>` resolving to `sol`, the flagship class.
- **Version** picks the highest table entry at or below the requested version **inside the same class**. A class with no entry returns `undefined` and the caller uses its generic body. A model never inherits another class's prompt: handing `haiku` a prompt tuned for `opus` is the overconstraint problem, not a fallback.

Adding a model is one row. Changing a class's prompt is one row. Nothing else in the code has to know.

## 2. Write in the vendor's own idiom

The two vendors do not respond best to the same shape, and pretending otherwise wastes the model's capability.

**Anthropic (Opus, Fable/Mythos).**

- XML sections (`<Role>`, `<completion>`, `<boundaries>`) — Claude is trained to parse them, and they keep the prompt's parts from bleeding into each other.
- Positive instructions. "Write flowing prose" beats "do not use markdown"; a bare prohibition without a replacement behavior is the weak form.
- Context for each rule. A one-line reason makes the rule generalizable.
- Thinking is always on in the current models. Effort is the control, so the prompt never asks the model to think harder and never asks it to write its reasoning into the reply — the latter is the `reasoning_extraction` refusal category.
- A long agent turn can end on text with work still owed. Name the specific stops to avoid and the stops that are real; put status notes in the same message as the next tool call.
- For a flow lead, an elapsed-time budget tightens parallel convergence.
- Frontend work with no design direction: name the specific patterns to avoid. "Avoid a generic look" just swaps one default for another.

**OpenAI (Astra and the codenamed families).**

- Markdown hierarchy for structure, XML only where a bounded block needs a clear edge.
- Define completion up front as observable conditions. Astra stops at a first implementation and hands back unless the request says what "done" includes.
- Grant persistence explicitly, and name the early stops to avoid alongside the real ones.
- Narrow the boundaries. Strict "ask first" language written to restrain earlier models reads as a reason to pause.
- Do not ask for preambles or an intent line in an unattended run; that is a known cause of an early stop.
- Do not pile on verification instructions. Current models run tests and check their own work; repeated "verify again" guidance produces unnecessary work.
- Fewer itineraries. Guidance written for smaller models overconstrains the strong one. State outcomes and decision rules, not a step list.

**Other carriers (Kimi, GLM, Grok, Gemini, older GPT).** Their retained variants stay as they are. The three primary workflows do not target them, so they are not where prompt effort goes; the category lanes still use them, and their prompts are unchanged.

## 3. The flow is a capability, not a ledger

OpenCode 2 has no todo tool. The OMO-era `todowrite` / `TaskCreate` guidance was removed for a reason: a bookkeeping list adds no capability and costs context on every turn. It also promised a `[SYSTEM REMINDER - TODO CONTINUATION]` hook that does not exist, so a model created a list, waited for a nudge that never came, and finished outside the graph.

Replacing it with "the flow is your checklist" is the same mistake under a new name. The flow section therefore says what `iolaus_flow` **gives you** and leaves the decision to the model:

- a fresh session per node, so the orchestrator holds conclusions instead of transcripts;
- `dependsOn` for order and `inputs` for passing results without restating them;
- parallel nodes that join;
- retry of one node without restating the task;
- a gate that waits for the user.

It is worth its coordination cost only when one of those is load-bearing: a part that consumes another part's output, parallel work that materially shortens the job, a step likely to need a rerun, or a decision only the user can make. Otherwise one `subagent` call, or do the work.

Workers (Hephaestus, category lanes) get the completion contract instead: finish your part, run what you changed, report what you observed, do not create a flow of your own.

## 4. Keyword modes are explicit intent

A leading keyword selects a mode, the same way the slash command does, and hands the session to that mode's owner. Only agent ownership changes; the user's model choice is kept.

| You type | Mode | What it mandates |
| --- | --- | --- |
| `ulw <task>`, `ultrawork <task>` | `ultrawork` | First tool call is `iolaus_flow` with the `ultrawork` template, then wait |
| `ulw plan <req>`, `ulw-plan <req>` | `hyperplan` | Adversarial planning through the `hyperplan` template; the plan lands in `.iolaus/plans/<plan>/` |
| `ulw-execute <plan>` | `start-work` | Atlas runs the plan, one fresh session per ticket |
| `mass-ulw <task>`, `/mass-ulw` | `mass-ulw` | The agent writes the dependency graph itself and drives it through `iolaus_flow`, one run per phase |

`mass-ulw` is a mode, not a template: the task decides the phases, so no built-in graph exists. Its mandate is "the first run exists before implementation starts" and "each later phase is a new run fed by `inputs` from the previous one".

The distinction matters: **keyword modes mandate the flow; the ordinary prompt only describes it**. A keyword is the user saying which workflow they want, so the mode is allowed to be prescriptive. Without one, the model decides.

## 5. Three workflows, three prompt shapes

- **Sisyphus — general work, human in the loop.** Keeps an implementation gate ("do not start unless asked"), computes intent, and delegates. It may use a flow for same-turn parallel work. It does not get the unattended early-stop list, because in a session a user is present to answer.
- **Hephaestus — unattended long work.** Completion conditions up front, persistence granted, early stops named, verification run once. The goal loop continues the session until the goal is met, with a hard continuation cap.
- **Prometheus → Atlas — planner and executor.** Prometheus is plan-only and model-independent: `renderAgent` drops the model and there is one prompt. Atlas executes a validated plan, one fresh session per ticket, with a gate before merge. This split is the harness's answer to context growth: the planning conversation never enters an implementer's context.

## 6. No prompt names a tool the harness does not register

A prompt that tells the model to call a missing tool is a defect, not a stylistic choice. Every removed OMO surface is asserted absent in tests and in the live QA:

`todowrite`, `task_create`, `TaskCreate`, `TaskUpdate`, `task_update`, `TODO CONTINUATION`, `TASK CONTINUATION`, `background_output`, `background_cancel`, `load_skills`, `run_in_background`, `subagent_type`, `call_omo_agent`, `delegate_task`, `team_create` (and the rest of the `team_*` set), `update_plan`, `oh-my-opencode`, and the `ulw-plan` skill.

The native contract is `subagent({agent, description, prompt, background?, sessionID?})`, `skill({id})`, and `iolaus_flow`.

## 7. Verification

Prompt changes are verified at two levels:

- Unit tests assert routing, tool contracts, and that no dead tool name survives in a rendered prompt.
- `script/qa-prompt-lanes.mjs` runs real sessions in an isolated HOME against a local mock, one per model identity, and asserts on the system prompt the host actually sent. Tests of authored prose wording, section order or length are deliberately not written: the prompt is behavior, not copy.
- A change to which model gets which prompt also gets an assertion on the **model-independence** property where it holds. Prometheus is run on two models and its rendered text must match byte for byte outside the host's own fragments.

## 8. How to change this next time

1. Read the vendor's current guidance for the model class before touching its prompt. Do not carry a rule over because it worked on the previous generation.
2. Decide whether the change adds a **capability** or a **procedure**. Procedures constrain a capable model; add them only where a measured failure requires one.
3. Never replace one form of bookkeeping with another. If a list-like mechanism is tempting, ask what it buys the model that it could not compute itself.
4. Route by model identity in the table, not with a new predicate in a builder.
5. Add the negative assertion. If a tool name, path or skill can be missing, the test suite should fail when a prompt mentions it.
6. Verify with a real session, not only with a string check, when the change is about what the model does.
