import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { homeContract, provisionHome, resolveHome } from "../src/home"
import { loadModelsConfig } from "../src/models"
import { loadVerifyConfig } from "../src/verify/config"
import { bindNative } from "../src/prompts/render"

test("home resolves from IOLAUS_HOME with a project overlay, provisions idempotently and never overwrites", () => {
  const root = mkdtempSync(join(tmpdir(), "iolaus-home-"))
  const project = join(root, "proj"); mkdirSync(project)
  const home = resolveHome(project, { IOLAUS_HOME: join(root, "userhome") })
  expect(home.user).toBe(join(root, "userhome"))
  expect(home.userPlans).toBe(join(root, "userhome", "agent", "plans"))
  expect(home.project).toBe(join(project, ".iolaus"))
  const first = provisionHome(home)
  expect(first.created.length).toBe(9)
  for (const dir of [home.userAgent, home.userMemory, home.userSkills, home.projectPlans, home.projectDag]) expect(existsSync(dir)).toBe(true)
  writeFileSync(join(home.user, "README.md"), "custom")
  expect(provisionHome(home).created).toEqual([])
  expect(readFileSync(join(home.user, "README.md"), "utf8")).toBe("custom")
  expect(resolveHome(project, {}).user.endsWith(join(".iolaus"))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test("user-layer models.json and verify.json are read, and project files override them", () => {
  const root = mkdtempSync(join(tmpdir(), "iolaus-home-"))
  const osHome = join(root, "oshome"); const project = join(osHome, "work", "proj")
  mkdirSync(join(osHome, ".iolaus"), { recursive: true }); mkdirSync(join(project, ".iolaus"), { recursive: true })
  writeFileSync(join(osHome, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "openai/user-model", momus: "openai/user-momus" } }))
  writeFileSync(join(project, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "openai/project-model" } }))
  const models = loadModelsConfig(project, { home: osHome })
  expect(models.config.agents?.oracle).toBe("openai/project-model")
  expect(models.config.agents?.momus).toBe("openai/user-momus")
  expect(models.sources.length).toBe(2)
  writeFileSync(join(osHome, ".iolaus", "verify.json"), JSON.stringify({ checkers: [{ argv: ["user-check"] }] }))
  expect(loadVerifyConfig(project, undefined, join(osHome, ".iolaus")).checkers[0]?.argv).toEqual(["user-check"])
  writeFileSync(join(project, ".iolaus", "verify.json"), JSON.stringify({ checkers: [{ argv: ["project-check"] }] }))
  expect(loadVerifyConfig(project, undefined, join(osHome, ".iolaus")).checkers[0]?.argv).toEqual(["project-check"])
  rmSync(root, { recursive: true, force: true })
})

test("home contract is appended after the native contract", () => {
  const home = resolveHome("/p", { IOLAUS_HOME: "/u" })
  const text = bindNative("PROMPT", homeContract(home))
  expect(text.indexOf("<iolaus-native-contract>")).toBeLessThan(text.indexOf("<iolaus-home>"))
  expect(text).toContain("Write plans to /p/.iolaus/plans")
  expect(text).toContain("/u/agent/memory")
  expect(bindNative("PROMPT")).not.toContain("<iolaus-home>")
})
