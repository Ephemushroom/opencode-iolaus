import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Iolaus reads configuration only from `IOLAUS_HOME/iolaus.json` (default
 * `~/.iolaus/iolaus.json`). The project layer holds plans and QA evidence. Skills
 * and memory are the host's (and the user's plugins') concern, not Iolaus's.
 */
export interface IolausHome {
  readonly user: string
  readonly project: string
  readonly projectPlans: string
  readonly database: string
}

export const HOME_ENV = "IOLAUS_HOME"

export function resolveHome(projectDirectory: string, env: NodeJS.ProcessEnv = process.env): IolausHome {
  const user = resolve(env[HOME_ENV] ?? join(homedir(), ".iolaus"))
  const project = join(resolve(projectDirectory), ".iolaus")
  return { user, project, projectPlans: join(project, "plans"), database: join(user, "iolaus.db") }
}

const USER_README = `# Iolaus home

Shared across projects. iolaus.json configures features, models and verification;
iolaus.db stores DAG runs and session state. Project-level .iolaus/plans/ holds
plans and .iolaus/evidence/ holds QA evidence, not configuration overrides or
runtime state. Legacy state files are ignored.
`

export interface ProvisionResult {
  readonly created: readonly string[]
}

/** Creates only the user layer. Project plans and QA evidence are created when written. */
export function provisionHome(home: IolausHome): ProvisionResult {
  const created: string[] = []
  for (const dir of [home.user]) {
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
  return `<iolaus-home>Iolaus config: ${home.user}/iolaus.json. DAG and session state: ${home.database}; plans belong in ${home.projectPlans}. Skills and cross-session memory come from the host and its plugins, not from Iolaus.</iolaus-home>`
}
