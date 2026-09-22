import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { parseFrontmatter } from "@oh-my-opencode/utils"
import { sharedSkillsRootPath } from "@oh-my-opencode/shared-skills"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import { Effect } from "effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"

export interface SharedSkillsRegistrationContext {
  readonly skill: {
    readonly transform: (callback: (draft: SkillEditor) => void) => Effect.Effect<unknown, never, import("effect").Scope.Scope>
  }
}

interface SharedSkillFile {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly location: string
  readonly content: string
}

interface SharedSkillFrontmatter {
  readonly name?: unknown
  readonly description?: unknown
}

export function readSharedSkillFiles(root: string): readonly SharedSkillFile[] {
  let entries: readonly string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }

  const skills: SharedSkillFile[] = []
  for (const entry of [...entries].sort()) {
    const location = join(root, entry, "SKILL.md")
    let raw: string
    try {
      if (!statSync(join(root, entry)).isDirectory()) continue
      raw = readFileSync(location, "utf8")
    } catch {
      continue
    }

    const parsed = parseFrontmatter<SharedSkillFrontmatter>(raw)
    const name = typeof parsed.data.name === "string" && parsed.data.name.length > 0 ? parsed.data.name : entry
    const description = typeof parsed.data.description === "string" ? parsed.data.description : undefined
    skills.push({
      id: entry,
      name,
      description,
      location,
      content: parsed.hadFrontmatter ? parsed.body : raw,
    })
  }
  return skills
}

export function registerSharedSkills(
  ctx: SharedSkillsRegistrationContext,
  trace?: (event: string, detail?: Record<string, unknown>) => void,
): Effect.Effect<void, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
  const path = sharedSkillsRootPath()
  const skills = readSharedSkillFiles(path)

  yield* ctx.skill.transform((draft) => {
    for (const skill of skills) {
      draft.add(
        Skill.Info.make({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.name),
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: AbsolutePath.make(skill.location),
          content: skill.content,
        }),
      )
    }
  })

  trace?.("omo.skills.registered", { path, count: skills.length })
  })
}
