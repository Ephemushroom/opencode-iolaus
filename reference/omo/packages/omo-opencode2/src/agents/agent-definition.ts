import type { AgentMode } from "@oh-my-opencode/agents-core"

/**
 * A single permission rule in the OpenCode 2 (v2) ruleset shape.
 * `resource` is a glob; "*" matches all.
 */
export interface AgentPermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/**
 * Declarative, harness-neutral definition of one OMO agent.
 *
 * The prompt text lives in @oh-my-opencode/agents-core (model-family routing
 * resolved per model at registration time); the model fallback chain lives in
 * @oh-my-opencode/model-core's AGENT_MODEL_REQUIREMENTS. This module only holds
 * the static per-agent attributes that both harness adapters agree on.
 */
export interface AgentDefinition {
  /** Stable agent id registered with the harness. */
  id: string;
  /** Short UI label (Agent.Name). */
  name: string;
  /** One-line description shown in the tool catalog. */
  description: string;
  /** UI mode: primary agents follow the user's model pick; subagents use their own chain. */
  mode: AgentMode;
  /** Whether the agent is hidden from the interactive model selector. */
  hidden?: boolean;
  /** Accent color (hex). */
  color?: string;
  /** Base sampling settings applied to the agent request. */
  request?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
  /** Permission ruleset (v2 shape). */
  permissions: AgentPermissionRule[];
}

/** Deny a set of tool actions for a subagent. */
export function denyTools(...tools: string[]): AgentPermissionRule[] {
  return tools.map((tool) => ({ action: tool, resource: "*", effect: "deny" as const }));
}

/** Allow only a set of tool actions; everything else denied. */
export function allowOnlyTools(...tools: string[]): AgentPermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" as const },
    ...tools.map((tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
  ];
}
