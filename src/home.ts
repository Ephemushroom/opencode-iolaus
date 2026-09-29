import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Iolaus reads configuration only from `IOLAUS_HOME/iolaus.json` (default
 * `~/.iolaus/iolaus.json`). The project layer holds DAG state and plans. Skills
 * and memory are the host's (and the user's plugins') concern, not Iolaus's.
 */
export interface IolausHome {
  readonly user: string
  readonly project: string
  readonly projectPlans: string
  readonly projectDag: string
}

export const HOME_ENV = "IOLAUS_HOME"

export function resolveHome(projectDirectory: string, env: NodeJS.ProcessEnv = process.env): IolausHome {
  const user = resolve(env[HOME_ENV] ?? join(homedir(), ".iolaus"))
  const project = join(resolve(projectDirectory), ".iolaus")
  return { user, project, projectPlans: join(project, "plans"), projectDag: join(project, "dag") }
}

const USER_README = `# Iolaus home

Shared across projects. iolaus.json configures features, models and verification.
Project-level .iolaus/ holds DAG state and plans, not configuration overrides.
`

export interface ProvisionResult {
  readonly created: readonly string[]
}

/** Creates the user layer and the project layer's plan/DAG directories. Idempotent; never touches existing files. */
export function provisionHome(home: IolausHome): ProvisionResult {
  const created: string[] = []
  for (const dir of [home.user, home.project, home.projectPlans, home.projectDag]) {
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    created.push(dir)
  }
  const readme = join(home.user, "README.md")
  if (!existsSync(readme)) { writeFileSync(readme, USER_README); created.push(readme) }
  const config = join(home.user, "iolaus.json")
  try { writeFileSync(config, "{}\n", { flag: "wx" }); created.push(config) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  return { created }
}

/** Sentence appended to every rendered prompt so agents write to the right place. */
export function homeContract(home: IolausHome): string {
  return `<iolaus-home>Iolaus config: ${home.user}/iolaus.json. Project DAG state belongs in ${home.projectDag}; plans belong in ${home.projectPlans}. Skills and cross-session memory come from the host and its plugins, not from Iolaus.</iolaus-home>`
}
