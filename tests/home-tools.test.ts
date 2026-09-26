import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { provisionHome, resolveHome } from "../src/home"
import { loadHomeSkills, registerHomeSkills } from "../src/home-skills"
import { createMemoryTools, listNotes } from "../src/home-memory"
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

test("memory tools: write/read/list/remove across layers with slug and size validation", async () => {
  const { root, home } = fixture()
  const tools = createMemoryTools({ home: async () => home })
  const call = (name: string, input: unknown) => Effect.runPromise(tools.find((t) => t.name === name)!.execute(input as never, { sessionID: "s", agent: "iolaus-sisyphus" } as never)).then((r) => (r as { output: Record<string, unknown> }).output)
  expect(tools.map((t) => [t.name, t.options?.permission])).toEqual([["list", "read"], ["read", "read"], ["write", "memory"], ["remove", "memory"]])
  expect(await call("write", { slug: "db-conventions", text: "# DB\nUse snake_case" })).toMatchObject({ ok: true, layer: "project", replaced: false })
  expect(await call("write", { slug: "editor", text: "Prefer tabs", layer: "user" })).toMatchObject({ ok: true, layer: "user" })
  expect(readFileSync(join(home.project, "memory", "db-conventions.md"), "utf8")).toBe("# DB\nUse snake_case\n")
  expect(await call("read", { slug: "db-conventions" })).toMatchObject({ ok: true, layer: "project", text: "# DB\nUse snake_case\n" })
  expect(await call("read", { slug: "editor" })).toMatchObject({ ok: true, layer: "user" })
  expect((await call("list", {}) as { notes: { slug: string }[] }).notes.map((n) => n.slug).sort()).toEqual(["db-conventions", "editor"])
  expect(listNotes(home, "user").map((n) => n.title)).toEqual(["Prefer tabs"])
  expect(await call("write", { slug: "db-conventions", text: "v2" })).toMatchObject({ replaced: true })
  expect((await call("write", { slug: "../etc", text: "x" }) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT")
  expect((await call("write", { slug: "Big", text: "x" }) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT")
  expect((await call("write", { slug: "huge", text: "x".repeat(70_000) }) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT")
  expect((await call("read", { slug: "nope" }) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  expect(await call("remove", { slug: "editor", layer: "user" })).toMatchObject({ ok: true })
  expect(existsSync(join(home.userMemory, "editor.md"))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test("memory write permission goes to the primaries and metis; read-only specialists can list/read", async () => {
  const { root, project, home } = fixture()
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => {}, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  await Effect.runPromise(Effect.scoped(registerAgents({ agent: { transform: (run) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } }, parseOptions({}), {}, home)))
  const rules = (id: string) => agents.get(id)!.permissions as readonly PermissionRule[]
  for (const id of ["iolaus-sisyphus", "iolaus-hephaestus", "iolaus-prometheus", "iolaus-atlas", "iolaus-metis"]) expect(evaluate("memory", "*", rules(id))).toBe("allow")
  for (const id of ["iolaus-oracle", "iolaus-librarian", "iolaus-explore", "iolaus-momus"]) expect(evaluate("memory", "*", rules(id))).toBe("deny")
  expect(evaluate("read", "*", rules("iolaus-explore"))).toBe("allow")
  expect(evaluate("edit", `${home.userPlans}/x.md`, rules("iolaus-prometheus"))).toBe("allow")
  expect(evaluate("edit", join(project, "src", "a.ts"), rules("iolaus-prometheus"))).toBe("deny")
  rmSync(root, { recursive: true, force: true })
})
