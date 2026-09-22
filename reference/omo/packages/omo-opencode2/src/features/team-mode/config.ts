import { join } from "node:path"

import { TeamModeConfigSchema, type TeamModeConfig } from "@oh-my-opencode/team-core"

const MAX_PARALLEL_MEMBERS = 4
const MAX_TOTAL_MEMBERS = 8

export function createTeamCoreConfig(cwd: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({
    enabled: true,
    tmux_visualization: false,
    max_parallel_members: MAX_PARALLEL_MEMBERS,
    max_members: MAX_TOTAL_MEMBERS,
    base_dir: join(cwd, ".omo"),
  })
}
