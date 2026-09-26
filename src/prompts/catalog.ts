export const AGENT_NAMES = [
  "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior",
  "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker",
] as const
export type AgentName = typeof AGENT_NAMES[number]

export const MODE_NAMES = ["ultrawork", "hyperplan", "team"] as const
export type ModeName = typeof MODE_NAMES[number]

export const CATEGORY_NAMES = [
  "visual-engineering", "ultrabrain", "deep-low", "deep-high", "artistry",
  "quick", "unspecified-low", "unspecified-high", "writing",
] as const
export type CategoryName = typeof CATEGORY_NAMES[number]

export const PRIMARY_AGENTS: ReadonlySet<AgentName> = new Set<AgentName>(["sisyphus", "hephaestus", "prometheus", "atlas"])

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

// One-line lane descriptions follow OMO's builtin category definitions.
export const CATEGORY_DESCRIPTIONS: Record<CategoryName, string> = {
  "visual-engineering": "Visual design, UI/UX, frontend, styling, animation, and design systems.",
  ultrabrain: "Genuinely hard, logic-heavy tasks. Give clear goals only, not step-by-step instructions.",
  "deep-low": "Default deep lane: one goal, one deliverable, decisions the child can settle from what it reads. 3D graphics, computer/browser use, CAPTCHA, multimodal, backend, logic and algorithm work is routed here.",
  "deep-high": "Escalation deep lane: a goal whose central decision cannot be settled from evidence alone. Same one-goal, one-deliverable contract as deep-low.",
  artistry: "Complex problem-solving with unconventional, creative approaches beyond standard patterns.",
  quick: "Trivial tasks: single file changes, typo fixes, simple modifications.",
  "unspecified-low": "Tasks that do not fit other categories, low effort required.",
  "unspecified-high": "Tasks that do not fit other categories, high effort required.",
  writing: "Documentation, prose, technical writing.",
}

/** Agent ids are the bare names. Only `explore` exists in the host too; Iolaus takes that id over at registration. */
export function agentID(name: AgentName): string {
  return name
}

export function agentName(id: string): AgentName | undefined {
  return AGENT_NAMES.find((name) => agentID(name) === id)
}

/** Display name shown in the host UI: `sisyphus-junior` → `Sisyphus Junior`. The id keeps the `iolaus-` namespace. */
export function displayName(name: AgentName | CategoryName): string {
  return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}

export function categoryID(name: CategoryName): string {
  return name
}

export function categoryName(id: string): CategoryName | undefined {
  return CATEGORY_NAMES.find((name) => categoryID(name) === id)
}

export function modeMarker(mode: ModeName): string {
  return `<iolaus-mode:${mode}>`
}

export function explicitMode(text: string): ModeName | undefined {
  const marker = MODE_NAMES.find((mode) => text.startsWith(`${modeMarker(mode)}\n`))
  if (marker) return marker
  const command = text.match(/^"?\/(ultrawork|hyperplan|team)(?:\s|"|$)/)
  return command?.[1] as ModeName | undefined
}
