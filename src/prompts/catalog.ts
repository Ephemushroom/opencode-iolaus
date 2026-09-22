export const AGENT_NAMES = [
  "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior",
  "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker",
] as const
export type AgentName = typeof AGENT_NAMES[number]

export const MODE_NAMES = ["ultrawork", "hyperplan", "team"] as const
export type ModeName = typeof MODE_NAMES[number]

export const AGENT_DESCRIPTIONS: Record<AgentName, string> = {
  sisyphus: "OMO orchestration prompt with native OpenCode delegation.",
  hephaestus: "OMO deep implementation prompt for supported GPT models.",
  prometheus: "OMO planning prompt; writes plans under .iolaus/plans/.",
  atlas: "OMO plan-execution prompt using native OpenCode tools.",
  "sisyphus-junior": "Focused OMO implementation prompt without further delegation.",
  oracle: "Read-only architectural advice and difficult debugging.",
  librarian: "Read-only documentation and external source research.",
  explore: "Read-only codebase discovery with the OMO exploration prompt.",
  metis: "Read-only plan analysis and ambiguity discovery.",
  momus: "Read-only plan review and verification.",
  "multimodal-looker": "OMO media-analysis prompt using native read.",
}

export function agentID(name: AgentName): string {
  return `iolaus-${name}`
}

export function agentName(id: string): AgentName | undefined {
  return AGENT_NAMES.find((name) => agentID(name) === id)
}

export function modeMarker(mode: ModeName): string {
  return `<iolaus-mode:${mode}>`
}

export function explicitMode(text: string): ModeName | undefined {
  const marker = MODE_NAMES.find((mode) => text.startsWith(`${modeMarker(mode)}\n`))
  if (marker) return marker
  const command = text.match(/^"?\/iolaus-(ultrawork|hyperplan|team)(?:\s|"|$)/)
  return command?.[1] as ModeName | undefined
}
