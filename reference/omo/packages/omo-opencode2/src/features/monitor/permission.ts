import { tokenizeCommand } from "./types"

export interface MonitorPermissionConfig {
  readonly enabled: boolean
  readonly allowed_commands?: readonly string[] | undefined
}

export type MonitorPermissionVia = "allowlist" | "allowlist-unset" | "feature-disabled"

export interface MonitorPermissionResult {
  readonly allowed: boolean
  readonly reason: string
  readonly via: MonitorPermissionVia
}

/**
 * Gate for `monitor_start`.
 *
 * v1 could defer to OpenCode's bash permission prompt through `ToolContext.ask`.
 * The v2 tool context carries no equivalent, so this fails CLOSED to an explicit
 * allowlist: with no `monitor.allowed_commands`, no command runs. Do not soften
 * this into a default-allow. The tool spawns arbitrary processes, and the model
 * chooses the command string.
 */
export function checkMonitorCommandPermission(
  command: string,
  config: MonitorPermissionConfig,
): MonitorPermissionResult {
  if (!config.enabled) {
    return { allowed: false, reason: "monitor feature disabled", via: "feature-disabled" }
  }

  const allowed = config.allowed_commands ?? []
  if (allowed.length === 0) {
    return {
      allowed: false,
      reason:
        "monitor.allowed_commands is empty, so no command may be started. Add the program name (for example \"npm\" or \"tail\") to monitor.allowed_commands in your omo config.",
      via: "allowlist-unset",
    }
  }

  const program = tokenizeCommand(command)[0]
  if (program && allowed.includes(program)) {
    return { allowed: true, reason: `program "${program}" is in monitor.allowed_commands`, via: "allowlist" }
  }

  return {
    allowed: false,
    reason: `program "${program ?? "(empty)"}" is not in monitor.allowed_commands (allowed: ${allowed.join(", ")})`,
    via: "allowlist",
  }
}
