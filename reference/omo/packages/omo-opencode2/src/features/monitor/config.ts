import type { OpenCode2MonitorSettings } from "../../config/schema"
import type { MonitorRuntimeConfig } from "./manager"

export const MONITOR_DEFAULTS: MonitorRuntimeConfig = {
  enabled: false,
  live_mode_enabled: false,
  max_monitors_per_session: 3,
  max_runtime_ms: 1_800_000,
  batch_max_lines: 50,
  batch_max_bytes: 16_384,
  flush_interval_ms: 1_000,
  ring_max_lines: 1_000,
  line_max_bytes: 8_192,
  pattern_max_length: 512,
}

export function resolveMonitorConfig(settings: OpenCode2MonitorSettings | undefined): MonitorRuntimeConfig {
  return {
    enabled: settings?.enabled ?? MONITOR_DEFAULTS.enabled,
    live_mode_enabled: settings?.live_mode_enabled ?? MONITOR_DEFAULTS.live_mode_enabled,
    allowed_commands: settings?.allowed_commands,
    max_monitors_per_session: settings?.max_monitors_per_session ?? MONITOR_DEFAULTS.max_monitors_per_session,
    max_runtime_ms: settings?.max_runtime_ms ?? MONITOR_DEFAULTS.max_runtime_ms,
    batch_max_lines: settings?.batch_max_lines ?? MONITOR_DEFAULTS.batch_max_lines,
    batch_max_bytes: settings?.batch_max_bytes ?? MONITOR_DEFAULTS.batch_max_bytes,
    flush_interval_ms: settings?.flush_interval_ms ?? MONITOR_DEFAULTS.flush_interval_ms,
    ring_max_lines: settings?.ring_max_lines ?? MONITOR_DEFAULTS.ring_max_lines,
    line_max_bytes: settings?.line_max_bytes ?? MONITOR_DEFAULTS.line_max_bytes,
    pattern_max_length: settings?.pattern_max_length ?? MONITOR_DEFAULTS.pattern_max_length,
  }
}
