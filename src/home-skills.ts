import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { IolausHome } from "./home"
import { trace } from "./trace"

export const HOME_SKILL_PREFIX = "iolaus-home:"

export interface HomeSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
  readonly layer: "user" | "project"
}

function frontmatter(text: string): { readonly name?: string; readonly description?: string; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
  }
  return { name: fields.name, description: fields.description, body: text.slice(match[0].length) }
}

function scan(root: string, layer: HomeSkill["layer"]): HomeSkill[] {
  if (!existsSync(root)) return []
  const skills: HomeSkill[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    const file = join(dir, "SKILL.md")
    try { if (!statSync(dir).isDirectory() || !existsSync(file)) continue } catch { continue }
    const text = readFileSync(file, "utf8")
    const meta = frontmatter(text)
    const name = (meta.name ?? entry).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) continue
    skills.push({ id: `${HOME_SKILL_PREFIX}${name}`, name, description: meta.description ?? `Skill from ${layer} agent home`, path: dir, content: meta.body.trim(), layer })
  }
  return skills
}

/** Project skills shadow user skills of the same name; both live under `skills/<name>/SKILL.md`. */
export function loadHomeSkills(home: IolausHome): HomeSkill[] {
  const byName = new Map<string, HomeSkill>()
  for (const skill of scan(home.userSkills, "user")) byName.set(skill.name, skill)
  for (const skill of scan(join(home.project, "skills"), "project")) byName.set(skill.name, skill)
  return [...byName.values()]
}

/** Registers home skills with the host. A host skill that already owns the id is left alone. */
export function registerHomeSkills(ctx: { skill: Pick<Context["skill"], "transform"> }, home: IolausHome): Effect.Effect<readonly HomeSkill[], never, Scope.Scope> {
  const skills = loadHomeSkills(home)
  if (!skills.length) { trace("iolaus.home.skills", { registered: [], skipped: [] }); return Effect.succeed([]) }
  const registered: string[] = []
  const skipped: string[] = []
  return ctx.skill.transform((editor) => {
    registered.length = 0; skipped.length = 0
    for (const skill of skills) {
      if (editor.get(skill.id)) { skipped.push(skill.id); continue }
      editor.add({ id: skill.id, name: skill.name, description: skill.description, path: skill.path, content: skill.content } as never)
      registered.push(skill.id)
    }
    trace("iolaus.home.skills", { registered: [...registered], skipped: [...skipped] })
  }).pipe(Effect.as(skills))
}
