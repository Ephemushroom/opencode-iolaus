import { MODE_NAMES, type AgentName, type ModeName } from "../prompts/catalog"

/**
 * Commands that belong to one primary agent. When one arrives in a session running
 * another agent, the prompt hook switches the session to the owner before the turn.
 * `team` stays with whoever runs it.
 */
export const COMMAND_OWNERS = {
  ultrawork: "sisyphus",
  "mass-ulw": "sisyphus",
  hyperplan: "prometheus",
  goal: "hephaestus",
  "start-work": "atlas",
} as const satisfies Record<string, AgentName>

export const ROLE_COMMAND_NAMES = ["goal", "start-work"] as const
export type RoleCommandName = typeof ROLE_COMMAND_NAMES[number]
export type CommandName = typeof MODE_NAMES[number] | RoleCommandName

/**
 * OMO-style spellings. `ulw` is the short form of ultrawork, `ulw-plan` of the
 * planner, and `ulw-execute` of running the plan it wrote. They resolve to the
 * canonical names so ownership, the mode marker and the mode prompt stay one path.
 */
export const COMMAND_ALIASES: Readonly<Record<string, CommandName>> = {
  ulw: "ultrawork",
  ultra: "ultrawork",
  "ulw-plan": "hyperplan",
  "ulw-execute": "start-work",
}

export function canonicalCommand(name: string): CommandName | undefined {
  if ((MODE_NAMES as readonly string[]).includes(name) || (ROLE_COMMAND_NAMES as readonly string[]).includes(name)) return name as CommandName
  return COMMAND_ALIASES[name]
}

export function commandMarker(name: RoleCommandName): string {
  return `<iolaus-command:${name}>`
}

const MARKED = /^<iolaus-(mode|command):([a-z-]+)>\n/
const SLASH = /^"?\/(ultrawork|hyperplan|team|mass-ulw|ulw|ultra|ulw-plan|ulw-execute|goal|start-work)(?=\s|"|$)/

/**
 * Reads the command from a prompt: the marker a registered command's execute adds,
 * or the bare `/name args` text `opencode run` sends (sometimes quoted).
 */
export function parseCommand(text: string): { readonly name: CommandName; readonly args: string } | undefined {
  const marked = text.match(MARKED)
  if (marked) {
    const name = marked[2]
    const known = marked[1] === "mode" ? (MODE_NAMES as readonly string[]).includes(name) : (ROLE_COMMAND_NAMES as readonly string[]).includes(name)
    return known ? { name: name as CommandName, args: text.slice(marked[0].length).trim() } : undefined
  }
  const slash = text.match(SLASH)
  if (!slash) return undefined
  let args = text.slice(slash[0].length).trim()
  if (text.startsWith('"') && args.endsWith('"')) args = args.slice(0, -1).trim()
  const name = canonicalCommand(slash[1])
  return name ? { name, args } : undefined
}

/** The owner a prompt hands the session to: a slash command, or a leading `ulw` keyword. */
export function commandOwner(name: CommandName | ModeName | undefined): AgentName | undefined {
  return name && name in COMMAND_OWNERS ? COMMAND_OWNERS[name as keyof typeof COMMAND_OWNERS] : undefined
}
