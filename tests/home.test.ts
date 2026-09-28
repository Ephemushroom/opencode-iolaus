import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { homeContract, provisionHome, resolveHome } from "../src/home"
import { parseModelsConfig } from "../src/models"
import { loadVerifyConfig } from "../src/verify/config"
import { loadGlobalConfig } from "../src/global-config"
import { parseOptions } from "../src/options"
import { bindNative } from "../src/prompts/render"

test("home resolves from IOLAUS_HOME, provisions project DAG locally and never overwrites", () => {
  const root = mkdtempSync(join(tmpdir(), "iolaus-home-"))
  const project = join(root, "proj"); mkdirSync(project)
  const home = resolveHome(project, { IOLAUS_HOME: join(root, "userhome") })
  expect(home.user).toBe(join(root, "userhome"))
  expect(home.project).toBe(join(project, ".iolaus"))
  const first = provisionHome(home)
  expect(first.created.length).toBe(6)
  expect(readFileSync(join(home.user, "iolaus.json"), "utf8")).toBe("{}\n")
  for (const dir of [home.user, home.projectPlans, home.projectDag]) expect(existsSync(dir)).toBe(true)
  expect(existsSync(join(home.user, "agent"))).toBe(false)
  writeFileSync(join(home.user, "README.md"), "custom")
  writeFileSync(join(home.user, "iolaus.json"), "{\"gh\":false}\n")
  expect(provisionHome(home).created).toEqual([])
  expect(readFileSync(join(home.user, "README.md"), "utf8")).toBe("custom")
  expect(readFileSync(join(home.user, "iolaus.json"), "utf8")).toBe("{\"gh\":false}\n")
  expect(resolveHome(project, {}).user.endsWith(join(".iolaus"))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test("global file validates all sections before plugin setup", () => {
  const root = mkdtempSync(join(tmpdir(), "iolaus-global-"))
  const user = join(root, "user"); mkdirSync(user)
  const path = join(user, "iolaus.json")
  writeFileSync(path, JSON.stringify({ enabled: true, agents: ["oracle"], mcps: [], gh: false, models: { agents: { oracle: "global/oracle" } }, verify: { checkers: [{ argv: ["global-check"] }] } }))
  const options = parseOptions(loadGlobalConfig(user))
  expect(options.agents).toEqual(["oracle"])
  expect(options.mcps).toEqual([])
  for (const bad of ["{", "[]", "null", '{"enabled":"no"}', '{"unknown":true}', '{"models":{"agents":{"oracle":"bad"}}}', '{"models":{"agents":{"unknown":"a/b"}}}', '{"models":{"agents":{"oracle":{"model":"a/b","extra":true}}}}', '{"verify":{"checkers":[{"argv":[]}]}}', '{"verify":{"checkers":[{"argv":["x"],"extra":true}]}}', '{"verify":{"commentPattern":"("}}', '{"enabled":false,"models":{"invalid":true}}']) {
    writeFileSync(path, bad)
    expect(() => loadGlobalConfig(user)).toThrow(`Invalid Iolaus global config ${path}`)
  }
  rmSync(root, { recursive: true, force: true })
})

test("global model objects require both provider and model even when disabled", () => {
  const user = mkdtempSync(join(tmpdir(), "iolaus-global-model-"))
  try {
    for (const enabled of [true, false]) {
      for (const model of ["/deepseek-v4-flash", "ds-bryan/"]) {
        writeFileSync(join(user, "iolaus.json"), JSON.stringify({ enabled, models: { agents: { explore: { model } } } }))
        expect(() => loadGlobalConfig(user)).toThrow('explore.model must be "provider/model"')
      }
    }
  } finally { rmSync(user, { recursive: true, force: true }) }
})

test("only global iolaus.json supplies models and verify despite old files in either layer", () => {
  const root = mkdtempSync(join(tmpdir(), "iolaus-home-"))
  const user = join(root, "user"); const project = join(root, "project")
  mkdirSync(user); mkdirSync(join(project, ".iolaus"), { recursive: true })
  writeFileSync(join(user, "iolaus.json"), JSON.stringify({ models: { agents: { oracle: "global/oracle", explore: "ds-bryan/deepseek-v4-flash#max" } }, verify: { checkers: [{ argv: ["global-check"] }] } }))
  const global = loadGlobalConfig(user)
  expect(parseModelsConfig(global.models).agents?.oracle).toBe("global/oracle")
  expect(loadVerifyConfig(project, global.verify as Record<string, unknown>).checkers[0]?.argv).toEqual(["global-check"])
  writeFileSync(join(user, "models.json"), JSON.stringify({ agents: { oracle: "user/oracle" } }))
  writeFileSync(join(user, "verify.json"), JSON.stringify({ checkers: [{ argv: ["user-check"] }] }))
  writeFileSync(join(project, ".iolaus", "models.json"), JSON.stringify({ agents: { oracle: "project/oracle" } }))
  writeFileSync(join(project, ".iolaus", "verify.json"), JSON.stringify({ checkers: [{ argv: ["project-check"] }] }))
  expect(parseModelsConfig(loadGlobalConfig(user).models).agents).toEqual({ oracle: "global/oracle", explore: "ds-bryan/deepseek-v4-flash#max" })
  expect(loadVerifyConfig(project, global.verify as Record<string, unknown>).checkers[0]?.argv).toEqual(["global-check"])
  writeFileSync(join(user, "iolaus.json"), "{}\n")
  expect(parseModelsConfig(loadGlobalConfig(user).models ?? {}).agents).toEqual({})
  expect(loadVerifyConfig(project).source).toBe("detected")
  rmSync(root, { recursive: true, force: true })
})

test("home contract is appended after the native contract", () => {
  const home = resolveHome("/p", { IOLAUS_HOME: "/u" })
  const text = bindNative("PROMPT", homeContract(home))
  expect(text.indexOf("<iolaus-native-contract>")).toBeLessThan(text.indexOf("<iolaus-home>"))
  expect(text).toContain("plans belong in /p/.iolaus/plans")
  expect(text).toContain("/p/.iolaus/dag")
  expect(text).not.toContain("models.json")
  expect(text).not.toContain("tools.memory")
  expect(text).not.toContain("iolaus-home:")
  expect(bindNative("PROMPT")).not.toContain("<iolaus-home>")
})
