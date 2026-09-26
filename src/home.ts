import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Iolaus keeps agent state in two layers. The user layer is one directory for
 * every project (`IOLAUS_HOME`, default `~/.iolaus`): models and verify config,
 * plus `agent/` for plans and skills that should survive a
 * project. The project layer is `<project>/.iolaus`: DAG state, project plans
 * and project overrides of the same config files. Project wins over user.
 */
export interface IolausHome {
  readonly user: string
  readonly userAgent: string
  readonly userPlans: string
  readonly userSkills: string
  readonly project: string
  readonly projectPlans: string
  readonly projectDag: string
}

export const HOME_ENV = "IOLAUS_HOME"

export function resolveHome(projectDirectory: string, env: NodeJS.ProcessEnv = process.env): IolausHome {
  const user = resolve(env[HOME_ENV] ?? join(homedir(), ".iolaus"))
  const userAgent = join(user, "agent")
  const project = join(resolve(projectDirectory), ".iolaus")
  return {
    user, userAgent,
    userPlans: join(userAgent, "plans"), userSkills: join(userAgent, "skills"),
    project, projectPlans: join(project, "plans"), projectDag: join(project, "dag"),
  }
}

const USER_README = `# Iolaus agent home

Shared across projects. Iolaus reads:
- models.json   agent/category -> provider/model[#variant]
- verify.json   post-edit checkers (project .iolaus/verify.json overrides)
- agent/plans   plans Prometheus writes when a project has no .iolaus
- agent/skills  <name>/SKILL.md skills every project can invoke as iolaus-home:<name>

Project-level .iolaus/ overrides these and holds DAG state.
`

export interface ProvisionResult {
  readonly created: readonly string[]
}

/** Creates the user layer and the project layer's plan/DAG directories. Idempotent; never touches existing files. */
export function provisionHome(home: IolausHome): ProvisionResult {
  const created: string[] = []
  for (const dir of [home.user, home.userAgent, home.userPlans, home.userSkills, home.project, home.projectPlans, home.projectDag]) {
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    created.push(dir)
  }
  const readme = join(home.user, "README.md")
  if (!existsSync(readme)) { writeFileSync(readme, USER_README); created.push(readme) }
  return { created }
}

/** Sentence appended to every rendered prompt so agents write to the right place. */
export function homeContract(home: IolausHome): string {
  return `<iolaus-home>User layer ${home.user} (agent/plans, agent/skills; models.json, verify.json). Project layer ${home.project} (plans/, skills/, dag/; overrides). Write plans to ${home.projectPlans}; use ${home.userPlans} only when working outside a project. Skills under agent/skills/<name>/SKILL.md and .iolaus/skills/<name>/SKILL.md are loaded as \`iolaus-home:<name>\`. Cross-session memory is the host's concern, not Iolaus's.</iolaus-home>`
}
