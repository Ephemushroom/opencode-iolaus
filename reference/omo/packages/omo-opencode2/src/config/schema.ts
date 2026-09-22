import * as z from "zod"

export const OpenCode2AgentOverrideSchema = z.object({
  model: z.string().optional(),
  variant: z.string().optional(),
  prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  disable: z.boolean().optional(),
  description: z.string().optional(),
}).strip() // permissive: drops unknown fields from shared OmoAgentDef

export const OpenCode2GoalSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  auto_start: z.boolean().optional(),
  default_max_iterations: z.number().int().min(1).optional(),
}).strip()

export const OpenCode2TodoContinuationSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  // Consecutive continuations allowed without the remaining count dropping.
  // Any progress resets the budget, so this only bites on a stuck session.
  max_consecutive: z.number().int().min(1).optional(),
}).strip()

export const OpenCode2BoulderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
}).strip()

export const OpenCode2BtwSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Per-turn timeout for side conversation answers, milliseconds. */
  timeout_ms: z.number().int().min(1000).optional(),
}).strip()

export const OpenCode2ModelFallbackSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  max_retries: z.number().int().min(1).optional(),
}).strip()

export const OpenCode2TeamModeSettingsSchema = z.object({
  enabled: z.boolean().optional(),
}).strip()

// Field names mirror v1's monitor block so an existing config carries over.
// Default OFF, and with no allowed_commands the start tool refuses everything:
// the tool spawns arbitrary processes and the model picks the command string.
export const OpenCode2MonitorSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  live_mode_enabled: z.boolean().optional(),
  allowed_commands: z.array(z.string()).optional(),
  max_monitors_per_session: z.number().int().min(1).max(16).optional(),
  max_runtime_ms: z.number().int().min(1000).optional(),
  batch_max_lines: z.number().int().min(1).optional(),
  batch_max_bytes: z.number().int().min(1024).optional(),
  flush_interval_ms: z.number().int().min(250).optional(),
  ring_max_lines: z.number().int().min(1).optional(),
  line_max_bytes: z.number().int().min(256).optional(),
  pattern_max_length: z.number().int().min(1).optional(),
}).strip()

export const OpenCode2ConfigSchema = z.object({
  default_agent: z.string().optional(),
  agents: z.record(z.string(), OpenCode2AgentOverrideSchema).optional(),
  goal: OpenCode2GoalSettingsSchema.optional(),
  todo_continuation: OpenCode2TodoContinuationSettingsSchema.optional(),
  boulder: OpenCode2BoulderSettingsSchema.optional(),
  monitor: OpenCode2MonitorSettingsSchema.optional(),
  btw: OpenCode2BtwSettingsSchema.optional(),
  model_fallback: OpenCode2ModelFallbackSettingsSchema.optional(),
  team_mode: OpenCode2TeamModeSettingsSchema.optional(),
  disabled_hooks: z.array(z.string()).optional(),
  disabled_mcps: z.array(z.string()).optional(),
}).strip() // permissive: ignores all core root keys (categories, task, etc.)

export type OpenCode2AgentOverride = z.infer<typeof OpenCode2AgentOverrideSchema>
export type OpenCode2GoalSettings = z.infer<typeof OpenCode2GoalSettingsSchema>
export type OpenCode2TodoContinuationSettings = z.infer<typeof OpenCode2TodoContinuationSettingsSchema>
export type OpenCode2BoulderSettings = z.infer<typeof OpenCode2BoulderSettingsSchema>
export type OpenCode2MonitorSettings = z.infer<typeof OpenCode2MonitorSettingsSchema>
export type OpenCode2BtwSettings = z.infer<typeof OpenCode2BtwSettingsSchema>
export type OpenCode2ModelFallbackSettings = z.infer<typeof OpenCode2ModelFallbackSettingsSchema>
export type OpenCode2TeamModeSettings = z.infer<typeof OpenCode2TeamModeSettingsSchema>
export type OpenCode2Config = z.infer<typeof OpenCode2ConfigSchema>
