import { describe, expect, test } from "bun:test"

import { createContext7Config } from "./context7"
import { createGrepAppConfig } from "./grep-app"

describe("createContext7Config", () => {
  test("returns bare remote config without an api key", () => {
    const config = createContext7Config({})
    expect(config.type).toBe("remote")
    expect(config.url).toBe("https://mcp.context7.com/mcp")
    expect(config.headers).toBeUndefined()
    expect(config.oauth).toBe(false)
  })

  test("attaches a bearer header for a real key", () => {
    const config = createContext7Config({ CONTEXT7_API_KEY: "ctx7-real-key" })
    expect(config.headers).toEqual({ Authorization: "Bearer ctx7-real-key" })
  })

  test("treats placeholder keys as absent", () => {
    for (const placeholder of ["", "  ", "your-api-key", "YOUR API KEY", "<your api key>"]) {
      const config = createContext7Config({ CONTEXT7_API_KEY: placeholder })
      expect(config.headers).toBeUndefined()
    }
  })

  test("trims a real key", () => {
    const config = createContext7Config({ CONTEXT7_API_KEY: "  key  " })
    expect(config.headers).toEqual({ Authorization: "Bearer key" })
  })
})

describe("createGrepAppConfig", () => {
  test("returns the public endpoint with no auth", () => {
    const config = createGrepAppConfig()
    expect(config).toEqual({
      type: "remote",
      url: "https://mcp.grep.app",
      oauth: false,
    })
  })
})
