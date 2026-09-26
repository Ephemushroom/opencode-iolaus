import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { provisionHome, resolveHome } from "../src/home"
import { loadHomeSkills, registerHomeSkills } from "../src/home-skills"
import { registerAgents } from "../src/registration"
import { parseOptions } from "../src/options"
import { evaluate, type PermissionRule } from "../src/ast-grep/permissions"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "iolaus-home-tools-"))
  const project = join(root, "proj"); mkdirSync(project)
  const home = resolveHome(project, { IOLAUS_HOME: join(root, "userhome") })
  provisionHome(home)
  return { root, project, home }
}

test("home skills: user and project SKILL.md load, project shadows user, bad names skipped, host-owned ids untouched", async () => {
  const { root, home } = fixture()
  mkdirSync(join(home.userSkills, "deploy")); writeFileSync(join(home.userSkills, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nUser deploy steps\n")
  mkdirSync(join(home.userSkills, "review")); writeFileSync(join(home.userSkills, "review", "SKILL.md"), "Plain body, name from folder\n")
  mkdirSync(join(home.userSkills, "bad name!")); writeFileSync(join(home.userSkills, "bad name!", "SKILL.md"), "x")
  mkdirSync(join(home.project, "skills", "deploy"), { recursive: true }); writeFileSync(join(home.project, "skills", "deploy", "SKILL.md"), "---\ndescription: Project deploy\n---\nProject deploy steps\n")
  const skills = loadHomeSkills(home)
  expect(skills.map((s) => [s.name, s.layer, s.description])).toEqual([["deploy", "project", "Project deploy"], ["review", "user", "Skill from user agent home"]])
  expect(skills[0].content).toBe("Project deploy steps")
  const added: string[] = []
  const editor = { list: () => [], get: (id: string) => (id === "iolaus-home:review" ? { id } : undefined), add: (s: { id: string }) => { added.push(s.id) }, update: () => {}, remove: () => {} }
  await Effect.runPromise(Effect.scoped(registerHomeSkills({ skill: { transform: (run) => Effect.sync(() => { run(editor as never); return { dispose: Effect.void } }) } }, home)))
  expect(added).toEqual(["iolaus-home:deploy"])
  rmSync(root, { recursive: true, force: true })
})

test("prometheus may edit user-layer plans; project sources stay denied", async () => {
  const { root, project, home } = fixture()
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => {}, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  await Effect.runPromise(Effect.scoped(registerAgents({ agent: { transform: (run) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } }, parseOptions({}), {}, home)))
  const rules = (id: string) => agents.get(id)!.permissions as readonly PermissionRule[]
  expect(evaluate("read", "*", rules("iolaus-explore"))).toBe("allow")
  expect(evaluate("edit", `${home.userPlans}/x.md`, rules("iolaus-prometheus"))).toBe("allow")
  expect(evaluate("edit", join(project, "src", "a.ts"), rules("iolaus-prometheus"))).toBe("deny")
  rmSync(root, { recursive: true, force: true })
})
