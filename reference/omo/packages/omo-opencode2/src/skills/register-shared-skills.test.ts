import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

import { Skill } from "@opencode/schema/skill"
import { Effect } from "effect"

import { readSharedSkillFiles, registerSharedSkills } from "./register-shared-skills"
import type { SharedSkillsRegistrationContext } from "./register-shared-skills"
import { sharedSkillsRootPath } from "@oh-my-opencode/shared-skills"

function createDraftCapture(added: Skill.Info[]): SharedSkillsRegistrationContext {
  return {
    skill: {
      transform: (callback) => Effect.sync(() => {
        callback({
          list: () => [],
          get: () => undefined,
          add: (skill) => added.push(skill),
          update: () => undefined,
          remove: () => undefined,
        })
        return { dispose: Effect.void }
      }),
    },
  }
}

describe("registerSharedSkills", () => {
  test("#given the shared bundle #when registering #then every bundled skill is added", async () => {
    // given
    const added: Skill.Info[] = []
    const context = createDraftCapture(added)

    // when
    await Effect.runPromise(Effect.scoped(registerSharedSkills(context)))

    // then
    const ids = added.map((skill) => skill.id)
    expect(ids).toContain(Skill.ID.make("programming"))
    expect(ids).toContain(Skill.ID.make("git-master"))
    expect(ids).toContain(Skill.ID.make("ulw-execute"))
    expect(ids).not.toContain(Skill.ID.make("start-work"))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("#given a registered skill #when inspecting it #then location points at a real SKILL.md and content excludes frontmatter", async () => {
    // given
    const added: Skill.Info[] = []

    // when
    await Effect.runPromise(Effect.scoped(registerSharedSkills(createDraftCapture(added))))

    // then
    const gitMaster = added.find((skill) => skill.id === "git-master")
    expect(gitMaster).toBeDefined()
    if (!gitMaster) return
    expect(gitMaster.location.endsWith("SKILL.md")).toBe(true)
    expect(existsSync(gitMaster.location)).toBe(true)
    expect(gitMaster.content.startsWith("---")).toBe(false)
    expect(gitMaster.description).toBeTruthy()
  })

  test("#given a missing root #when reading skill files #then it yields an empty list", () => {
    // given
    const missing = "/definitely/not/a/real/shared/skills/root"

    // when
    const skills = readSharedSkillFiles(missing)

    // then
    expect(skills).toEqual([])
  })

  test("#given the real root #when reading skill files #then names come from frontmatter", () => {
    // given
    const root = sharedSkillsRootPath()

    // when
    const skills = readSharedSkillFiles(root)

    // then
    expect(skills.length).toBeGreaterThan(0)
    const gitMaster = skills.find((skill) => skill.id === "git-master")
    expect(gitMaster?.name).toBe("git-master")
  })
})
