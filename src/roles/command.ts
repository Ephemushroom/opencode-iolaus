import { MODE_NAMES, type AgentName } from "../prompts/catalog"

/**
 * Commands that belong to one primary agent. When one arrives in a session running
 * another agent, the prompt hook switches the session to the owner before the turn.
 * `team` stays with whoever runs it.
 */
export const COMMAND_OWNERS = {
  ultrawork: "sisyphus",
  hyperplan: "prometheus",
  goal: "hephaestus",
  "start-work": "atlas",
} as const satisfies Record<string, AgentName>

export const ROLE_COMMAND_NAMES = ["goal", "start-work"] as const
export type RoleCommandName = typeof ROLE_COMMAND_NAMES[number]
export type CommandName = typeof MODE_NAMES[number] | RoleCommandName

export function commandMarker(name: RoleCommandName): string {
  return `<iolaus-command:${name}>`
}

const MARKED = /^<iolaus-(mode|command):([a-z-]+)>\n/
const SLASH = /^"?\/(ultrawork|hyperplan|team|goal|start-work)(?=\s|"|$)/

/**
 * Reads the command from a prompt: the marker a registered command's execute adds,
 * or the bare `/name args` text `opencode run` sends (sometimes quoted).
 */
export function parseCommand(text: string): { readonly name: CommandName; readonly args: string } | undefined {
  const marked = text.match(MARKED)
  if (marked) {
    const name = marked[2] as CommandName
    const known = marked[1] === "mode" ? (MODE_NAMES as readonly string[]).includes(name) : (ROLE_COMMAND_NAMES as readonly string[]).includes(name)
    return known ? { name, args: text.slice(marked[0].length).trim() } : undefined
  }
  const slash = text.match(SLASH)
  if (!slash) return undefined
  let args = text.slice(slash[0].length).trim()
  if (text.startsWith('"') && args.endsWith('"')) args = args.slice(0, -1).trim()
  return { name: slash[1] as CommandName, args }
}
