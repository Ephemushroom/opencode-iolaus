import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"

import { loadOpenCode2Config } from "./loader"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function writeJsonc(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function makeFixture(): {
  readonly homeDir: string
  readonly projectDir: string
} {
  const root = mkdtempSync(join(tmpdir(), "opencode2-config-loader-"))
  roots.push(root)
  const homeDir = join(root, "home")
  const projectDir = join(root, "project")
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { homeDir, projectDir }
}

describe("loadOpenCode2Config", () => {
  test("#given separate v1 and v2 files #when both loaders run #then neither imports or rewrites the other's settings", () => {
    const fixture = makeFixture()
    const original = join(fixture.homeDir, ".omo", "omo.jsonc")
    const dedicated = join(fixture.homeDir, ".omo", "opencode2.json")
    const v1 = '{"agents":{"sisyphus":{"model":"v1/model"}}}'
    const v2 = '{"agents":{"sisyphus":{"model":"v2/model"}},"team_mode":{"enabled":true}}'
    writeJsonc(original, v1)
    writeJsonc(dedicated, v2)
    const env = { HOME: fixture.homeDir }
    const result = loadOpenCode2Config({ directory: fixture.projectDir, environment: env, options: {} })
    expect(result.config.agents?.sisyphus?.model).toBe("v2/model")
    expect(result.config.team_mode?.enabled).toBe(true)
    expect(result.sources).toEqual([dedicated])
    expect(loadOmoConfig({ cwd: fixture.projectDir, env, harness: "opencode" }).config.agents?.sisyphus?.model).toBe("v1/model")
    expect(readFileSync(original, "utf8")).toBe(v1)
    expect(readFileSync(dedicated, "utf8")).toBe(v2)
  })

  test("#given only original OMO files #when v2 loads #then no legacy user or project settings leak", () => {
    const fixture = makeFixture()
    for (const dir of [fixture.homeDir, fixture.projectDir]) {
      writeJsonc(join(dir, ".omo", "omo.jsonc"), '{"[opencode2]":{"default_agent":"leaked"},"agents":{"sisyphus":{"model":"v1/model"}}}')
    }
    const result = loadOpenCode2Config({ directory: fixture.projectDir, environment: { HOME: fixture.homeDir }, options: {} })
    expect(result.config).toEqual({})
    expect(result.sources).toEqual([])
  })
  test("#given layers with overlapping keys #when loaded #then precedence is base(user)<base(proj)<block(user)<block(proj)<options", () => {
    // given
    const fixture = makeFixture()
    writeJsonc(
      join(fixture.homeDir, ".omo", "opencode2.json"),
      `{
        "agents": { "sisyphus": { "model": "base-user", "temperature": 0.1 } },
        "[opencode2]": { "agents": { "sisyphus": { "model": "block-user" } }, "default_agent": "block-user-default" }
      }`
    )
    writeJsonc(
      join(fixture.projectDir, ".omo", "opencode2.json"),
      `{
        "agents": { "sisyphus": { "model": "base-proj", "description": "proj-desc" } },
        "[opencode2]": { "agents": { "sisyphus": { "model": "block-proj" } }, "default_agent": "block-proj-default" }
      }`
    )
    const options = { agents: { sisyphus: { model: "options-model" } } }

    // when
    const result = loadOpenCode2Config({
      directory: fixture.projectDir,
      environment: { HOME: fixture.homeDir },
      options,
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config.default_agent).toBe("block-proj-default")
    expect(result.config.agents?.sisyphus?.model).toBe("options-model")
    // Keys inherited from lower priority layers should be preserved
    expect(result.config.agents?.sisyphus?.temperature).toBe(0.1)
    expect(result.config.agents?.sisyphus?.description).toBe("proj-desc")
  })

  test("#given a missing config file #when loaded #then defaults survive with no errors", () => {
    // given
    const fixture = makeFixture()

    // when
    const result = loadOpenCode2Config({
      directory: fixture.projectDir,
      environment: { HOME: fixture.homeDir },
      options: {},
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config.default_agent).toBeUndefined()
  })

  test("#given both extensions #when loaded #then json wins and jsonc remains a fallback", () => {
    const fixture = makeFixture()
    const base = join(fixture.homeDir, ".omo")
    writeJsonc(join(base, "opencode2.jsonc"), '{/*comment*/"default_agent":"jsonc",}')
    const load = () => loadOpenCode2Config({ directory: fixture.projectDir, environment: { HOME: fixture.homeDir }, options: {} })
    expect(load().config.default_agent).toBe("jsonc")
    writeJsonc(join(base, "opencode2.json"), '{"default_agent":"json"}')
    expect(load().config.default_agent).toBe("json")
    writeJsonc(join(base, "opencode2.json"), '{"default_agent":')
    expect(load().config.default_agent).toBeUndefined()
    expect(load().diagnostics[0]?.path).toBe(join(base, "opencode2.json"))
  })

  test("#given nested project layers and a profile #when loaded #then nearest project and options win", () => {
    const fixture = makeFixture()
    const child = join(fixture.projectDir, "nested")
    mkdirSync(child)
    writeJsonc(join(fixture.homeDir, ".omo/opencode2.json"), '{"default_agent":"user","profiles":{"work":{"default_agent":"user-profile"}}}')
    writeJsonc(join(fixture.projectDir, ".omo/opencode2.json"), '{"default_agent":"project","profiles":{"work":{"default_agent":"project-profile"}}}')
    writeJsonc(join(child, ".omo/opencode2.json"), '{"profiles":{"work":{"default_agent":"nearest","agents":{"explore":{"model":"v2/profile"}}}}}')
    const input = { directory: child, environment: { HOME: fixture.homeDir, OMO_PROFILE: "work" }, options: {} }
    expect(loadOpenCode2Config(input).config.default_agent).toBe("nearest")
    expect(loadOpenCode2Config({ ...input, options: { default_agent: "options" } }).config.default_agent).toBe("options")
    expect(loadOpenCode2Config(input).config.agents?.explore?.model).toBe("v2/profile")
  })

  test("#given project symlinks to original OMO #when loaded #then refuse the linked settings", () => {
    const fixture = makeFixture()
    const original = join(fixture.homeDir, ".omo/omo.json")
    writeJsonc(original, '{"default_agent":"v1"}')
    mkdirSync(join(fixture.projectDir, ".omo"))
    symlinkSync(original, join(fixture.projectDir, ".omo/opencode2.json"))
    const load = () => loadOpenCode2Config({ directory: fixture.projectDir, environment: { HOME: fixture.homeDir }, options: {} })
    expect(load().sources).toEqual([])
    rmSync(join(fixture.projectDir, ".omo"), { recursive: true })
    writeJsonc(join(fixture.homeDir, ".omo/opencode2.json"), '{"default_agent":"user"}')
    symlinkSync(join(fixture.homeDir, ".omo"), join(fixture.projectDir, ".omo"), "junction")
    expect(load().sources).toEqual([join(fixture.homeDir, ".omo/opencode2.json")])
  })

  test("#given no user security keys #when project and options request them #then both are stripped", () => {
    const fixture = makeFixture()
    const hostile = { mcp_env_allowlist: ["PROJECT"], browser_automation_engine: { playwright_mcp_args: ["--unsafe"] } }
    writeJsonc(join(fixture.projectDir, ".omo/opencode2.json"), JSON.stringify(hostile))
    const result = loadOpenCode2Config({ directory: fixture.projectDir, environment: { HOME: fixture.homeDir }, options: hostile })
    expect(result.rawConfig.mcp_env_allowlist).toBeUndefined()
    expect(result.rawConfig.browser_automation_engine).toEqual({})
  })

  test.each(["[]", "null", "42", '{"team_mode":{"enabled":"yes"}}'])("#given invalid v2 shape %s #when loaded #then report diagnostics without reading v1", (content) => {
    const fixture = makeFixture()
    writeJsonc(join(fixture.homeDir, ".omo/opencode2.json"), content)
    writeJsonc(join(fixture.homeDir, ".omo/omo.jsonc"), '{"[opencode2]":{"default_agent":"v1-leak"}}')
    const result = loadOpenCode2Config({ directory: fixture.projectDir, environment: { HOME: fixture.homeDir }, options: {} })
    expect(result.config).toEqual({})
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  test("#given a malformed config file #when loaded #then it returns diagnostics but does not throw", () => {
    // given
    const fixture = makeFixture()
    writeJsonc(join(fixture.homeDir, ".omo", "opencode2.json"), `{ "agents": { "bad" `)

    // when
    const result = loadOpenCode2Config({
      directory: fixture.projectDir,
      environment: { HOME: fixture.homeDir },
      options: {},
    })

    // then
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]?.kind).toBe("parse")
    expect(result.config.default_agent).toBeUndefined()
  })

  test("#given security-restricted keys in project or options #when loaded #then they are ignored and only user values are kept", () => {
    // given
    const fixture = makeFixture()
    writeJsonc(
      join(fixture.homeDir, ".omo", "opencode2.json"),
      `{
        "[opencode2]": {
          "mcp_env_allowlist": ["USER_KEY"],
          "browser_automation_engine": { "playwright_mcp_args": ["--user"] }
        }
      }`
    )
    writeJsonc(
      join(fixture.projectDir, ".omo", "opencode2.json"),
      `{
        "[opencode2]": {
          "mcp_env_allowlist": ["PROJ_KEY"],
          "browser_automation_engine": { "playwright_mcp_args": ["--proj"] }
        }
      }`
    )
    const options = {
      mcp_env_allowlist: ["OPTIONS_KEY"],
      browser_automation_engine: { playwright_mcp_args: ["--options"] }
    }

    // when
    const result = loadOpenCode2Config({
      directory: fixture.projectDir,
      environment: { HOME: fixture.homeDir },
      options,
    })

    // then
    expect(result.diagnostics).toEqual([])
    
    // Note: The adapter doesn't type these in OpenCode2ConfigSchema but they should exist 
    // on the returned object from the raw merger because they are user-only security keys.
    const rawResult = result.rawConfig
    expect(rawResult.mcp_env_allowlist).toEqual(["USER_KEY"])
    expect(rawResult.browser_automation_engine).toEqual({ playwright_mcp_args: ["--user"] })
  })
})
