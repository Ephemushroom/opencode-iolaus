import {
  categorizeTools,
} from "@oh-my-opencode/agents-core"
import type { AvailableAgent, AvailableCategory, AvailableSkill, AvailableTool } from "@oh-my-opencode/agents-core"

import { SISYPHUS_SPECIALIST_METADATA } from "../agents/prompt-metadata"
import { buildSisyphusPromptForModel } from "../agents/sisyphus-prompt"

export interface LiveAgent {
  id: string
  name: string
  description?: string
  mode?: string
}

export interface LiveSkill {
  name: string
  description?: string
  location?: string
}

export interface SisyphusContextInput {
  /** The runtime model id ("<provider>/<model>") used for family routing. */
  model: string
  /** The static Sisyphus prompt baked at registration (empty lists). */
  staticSisyphusPrompt: string
  /** The mutable system part array from the context hook event. */
  system: Array<{ type: string; text?: string; [key: string]: unknown }>
  /** The mutable tools record from the context hook event. */
  tools: Record<string, { description?: string; input?: unknown }>
  /** Live agents (from ctx.agent.list()) or undefined when unavailable. */
  agentList?: LiveAgent[]
  /** Error thrown while fetching the live agent list. */
  agentListError?: unknown
  /** Live skills (from ctx.skill.list()) or undefined when unavailable. */
  skillList?: LiveSkill[]
  /** Error thrown while fetching the live skill list. */
  skillListError?: unknown
}

export interface SisyphusContextOutput {
  system: Array<{ type: string; text?: string; [key: string]: unknown }>
  rebaked: boolean
}

/**
 * Rebakes the static Sisyphus system part with the live agent/tool/skill/
 * category lists on every model request.
 *
 * Only the system part whose text exactly equals the registration-time static
 * Sisyphus prompt is replaced; project and third-party parts are preserved
 * byte-for-byte in order. Categories are derived from the live agent list (any
 * agent whose id is a CATEGORY_MODEL_REQUIREMENTS key), never from the
 * specialist metadata table. If the live catalog fetch failed, the static
 * prompt is preserved and rebaked=false (non-fatal).
 */
export function rebakeSisyphusSystemPart(input: SisyphusContextInput): SisyphusContextOutput {
  const system = input.system

  // Locate the static sisyphus part (the only part we may replace).
  const targetIndex = system.findIndex((part) => part.type === "text" && part.text === input.staticSisyphusPrompt)
  if (targetIndex === -1) {
    return { system, rebaked: false }
  }

  // Non-fatal: if the live catalog failed, keep the static prompt.
  if (input.agentListError !== undefined || input.skillListError !== undefined) {
    return { system, rebaked: false }
  }
  if (!input.agentList) {
    return { system, rebaked: false }
  }

  // Build AvailableAgent[] from live agents that carry specialist metadata.
  const availableAgents: AvailableAgent[] = input.agentList
    .filter((agent) => agent.id in SISYPHUS_SPECIALIST_METADATA)
    .map((agent) => ({
      name: agent.id,
      description: agent.description ?? "",
      metadata: SISYPHUS_SPECIALIST_METADATA[agent.id as keyof typeof SISYPHUS_SPECIALIST_METADATA],
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  // Categories are live agents whose id is a category (deep, quick, ...).
  const categoryIds = new Set(Object.keys(SISYPHUS_SPECIALIST_METADATA))
  const availableCategories: AvailableCategory[] = input.agentList
    .filter((agent) => !categoryIds.has(agent.id))
    .map((agent) => ({ name: agent.id, description: agent.description ?? "" }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  // Tools from the context event (sorted for determinism).
  const availableTools: AvailableTool[] = categorizeTools(Object.keys(input.tools).toSorted())

  // Skills from the live skill list (sorted for determinism).
  const availableSkills: AvailableSkill[] = (input.skillList ?? [])
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      location: (skill.location as AvailableSkill["location"]) ?? "plugin",
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  const rebuilt = buildSisyphusPromptForModel(
    input.model,
    availableAgents,
    availableTools,
    availableSkills,
    availableCategories,
    false,
  )

  const next = [...system]
  next[targetIndex] = { ...system[targetIndex], text: rebuilt }
  return { system: next, rebaked: true }
}
