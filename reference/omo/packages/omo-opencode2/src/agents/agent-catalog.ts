import type { AgentMode } from "@oh-my-opencode/agents-core"
import {
  SISYPHUS_JUNIOR_DEFAULTS,
  buildSisyphusJuniorPrompt,
  buildLibrarianPrompt,
  LIBRARIAN_AGENT_DESCRIPTION,
  EXPLORE_PROMPT,
  EXPLORE_AGENT_DESCRIPTION,
  MULTIMODAL_LOOKER_PROMPT,
  MULTIMODAL_LOOKER_AGENT_DESCRIPTION,
  getMetisPrompt,
  METIS_AGENT_DESCRIPTION,
  getMomusPromptSelection,
  MOMUS_AGENT_DESCRIPTION,
  getOraclePromptSelection,
  ORACLE_AGENT_DESCRIPTION,
} from "@oh-my-opencode/agents-core"

import type { AgentDefinition, AgentPermissionRule } from "./agent-definition"
import { allowOnlyTools, denyTools } from "./agent-definition"

export interface ResolvedAgentDefinition extends AgentDefinition {
  /** Builds the system prompt for the resolved model. */
  buildPrompt: (model: string) => string;
}

const SUBAGENT: AgentMode = "subagent"

/**
 * The declarative catalog of OMO agents registered with OpenCode 2.
 * Sisyphus and Hephaestus are added separately (they take runtime context), as
 * is Atlas (orchestrator with its own context shape).
 */
export const SUBAGENT_DEFINITIONS: ResolvedAgentDefinition[] = [
  {
    id: "oracle",
    name: "oracle",
    description: ORACLE_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: denyTools("write", "edit", "apply_patch", "task"),
    request: { temperature: 0.1 },
    buildPrompt: (model) => getOraclePromptSelection(model).prompt,
  },
  {
    id: "librarian",
    name: "librarian",
    description: LIBRARIAN_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: denyTools("write", "edit", "apply_patch", "task", "call_omo_agent"),
    request: { temperature: 0.1 },
    buildPrompt: () => buildLibrarianPrompt(),
  },
  {
    id: "explore",
    name: "explore",
    description: EXPLORE_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: denyTools("write", "edit", "apply_patch", "task", "call_omo_agent"),
    request: { temperature: 0.1 },
    buildPrompt: () => EXPLORE_PROMPT,
  },
  {
    id: "multimodal-looker",
    name: "multimodal-looker",
    description: MULTIMODAL_LOOKER_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: allowOnlyTools("read"),
    request: { temperature: 0.1 },
    buildPrompt: () => MULTIMODAL_LOOKER_PROMPT,
  },
  {
    id: "metis",
    name: "metis",
    description: METIS_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: denyTools("write", "edit", "apply_patch"),
    request: { temperature: 0.3 },
    buildPrompt: (model) => getMetisPrompt(model),
  },
  {
    id: "momus",
    name: "momus",
    description: MOMUS_AGENT_DESCRIPTION,
    mode: SUBAGENT,
    permissions: denyTools("write", "edit", "apply_patch"),
    request: { temperature: 0.1 },
    buildPrompt: (model) => getMomusPromptSelection(model).prompt,
  },
  {
    id: "sisyphus-junior",
    name: "sisyphus-junior",
    description:
      "Focused task executor. Same discipline, no delegation. (Sisyphus-Junior - OhMyOpenCode)",
    mode: SUBAGENT,
    color: "#20B2AA",
    permissions: denyTools("task"),
    request: { temperature: SISYPHUS_JUNIOR_DEFAULTS.temperature, maxOutputTokens: 64000 },
    buildPrompt: (model) => buildSisyphusJuniorPrompt(model, false),
  },
]
