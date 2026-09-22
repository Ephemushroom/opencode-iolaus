import { describe, expect, test } from "bun:test"
import { OpenCode2ConfigSchema } from "./schema"

describe("OpenCode2ConfigSchema", () => {
  test("#given an adapter config with core schema keys #when parsed #then strict fields validate and core keys are silently stripped", () => {
    // given
    const raw = {
      default_agent: "atlas",
      disabled_hooks: ["hashline", "write-existing-file-guard"],
      goal: { enabled: true },
      model_fallback: { enabled: true, max_retries: 2 },
      team_mode: { enabled: true },
      agents: {
        sisyphus: {
          model: "openai/gpt-5.6-sol",
          unknown_field: 42,
        },
      },
      categories: { quick: { model: "foo" } }, // ignored core root key
    }

    // when
    const result = OpenCode2ConfigSchema.safeParse(raw)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data.default_agent).toBe("atlas")
    expect(result.data.disabled_hooks).toEqual(["hashline", "write-existing-file-guard"])
    expect(result.data.model_fallback).toEqual({ enabled: true, max_retries: 2 })
    expect(result.data.agents?.sisyphus?.model).toBe("openai/gpt-5.6-sol")
    expect(result.data.team_mode?.enabled).toBe(true)
    expect("unknown_field" in (result.data.agents?.sisyphus ?? {})).toBe(false)
    expect("categories" in result.data).toBe(false)
  })

  test("#given malformed typed fields #when parsed #then schema rejects it with clear issue paths", () => {
    // given
    const raw = { default_agent: 123 }

    // when
    const result = OpenCode2ConfigSchema.safeParse(raw)

    // then
    expect(result.success).toBe(false)
  })

  test("#given a model fallback retry bound below one #when parsed #then schema rejects it", () => {
    // given
    const raw = { model_fallback: { enabled: true, max_retries: 0 } }

    // when
    const result = OpenCode2ConfigSchema.safeParse(raw)

    // then
    expect(result.success).toBe(false)
  })

  test("#given a malformed team mode gate #when parsed #then the schema rejects it", () => {
    // given
    const raw = { team_mode: { enabled: "yes" } }

    // when
    const result = OpenCode2ConfigSchema.safeParse(raw)

    // then
    expect(result.success).toBe(false)
  })
})
