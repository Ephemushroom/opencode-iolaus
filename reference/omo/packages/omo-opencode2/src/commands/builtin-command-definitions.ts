export interface BuiltinCommandDefinition {
  readonly name: string
  readonly description: string
  readonly template: string
  readonly agent?: string
  readonly subtask?: boolean
}

export const BUILTIN_COMMAND_DEFINITIONS: readonly BuiltinCommandDefinition[] = [
  {
    name: "goal",
    description: "(builtin) Set, show, pause, resume, or clear the active thread goal",
    template: `<command-instruction>
Treat $ARGUMENTS as a goal operation: an objective to set, or pause, resume, clear, or show. Use the active goal tools when available. Do not mark an objective complete until its success criteria are verified.
</command-instruction>`,
  },
  {
    name: "refactor",
    description:
      "(builtin) Intelligent refactoring command with LSP, AST-grep, architecture analysis, codemap, and TDD verification.",
    template: `<command-instruction>
Load the registered refactor skill, then follow it for this request:
$ARGUMENTS
</command-instruction>`,
  },
  {
    name: "ulw-execute",
    description: "(builtin) Start Atlas work session from Prometheus plan",
    agent: "atlas",
    template: `<command-instruction>
Load the registered ulw-execute skill, then execute the selected plan. Arguments: $ARGUMENTS
Session ID: $SESSION_ID
Timestamp: $TIMESTAMP
</command-instruction>`,
  },
  {
    name: "stop-continuation",
    description: "(builtin) Stop all continuation mechanisms (ralph loop, todo continuation, boulder) for this session",
    template: `<command-instruction>
Stop every active continuation mechanism for this session, including goal, todo continuation, and boulder work tracking. Report which mechanisms were stopped and which were unavailable.
</command-instruction>`,
  },
  {
    name: "handoff",
    description: "(builtin) Create a detailed context summary for continuing work in a new session",
    template: `<command-instruction>
Create a self-contained handoff for a new session. Preserve the user's requests verbatim, current goal, completed work, pending tasks, decisions, constraints, key files, verification state, and exact next action. Do not include secrets.
Requested focus: $ARGUMENTS
Session ID: $SESSION_ID
</command-instruction>`,
  },
  {
    name: "remove-ai-slops",
    description: "(builtin) Remove AI-generated code smells from branch changes and critically review the results",
    template: `<command-instruction>
Load the registered remove-ai-slops skill, then follow it for this request:
$ARGUMENTS
</command-instruction>`,
  },
  {
    name: "hyperplan",
    description: "(builtin) Adversarial multi-agent planning via independent hostile critiques",
    template: `<command-instruction>
Build an adversarial plan for $ARGUMENTS. Dispatch independent critics through the available native subagent categories, synthesize only defensible findings, and return one decision-complete execution plan.
</command-instruction>`,
  },
]
