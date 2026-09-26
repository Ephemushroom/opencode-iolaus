import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import { builtinMcpConfig, registerMcps, MCP_NAMES } from "../src/mcp"
import { parseOptions } from "../src/options"
import { registerAgents } from "../src/registration"
import { evaluate, type PermissionRule } from "../src/ast-grep/permissions"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"

type Config = Parameters<MCPEditor["set"]>[1]

function mcpRegistry(initial: Record<string, Config> = {}) {
  const servers = new Map<string, Config>(Object.entries(initial))
  const editor: MCPEditor = {
    list: () => [...servers.entries()] as never,
    get: (name) => servers.get(name) as never,
    set: (name, config) => { servers.set(name, config) },
    update: (name, update) => { const value = servers.get(name); if (value) update(value as never) },
    remove: (name) => { servers.delete(name) },
  }
  return { servers, ctx: { mcp: { transform: (run: (editor: MCPEditor) => void) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } } }
}

test("context7 config carries a bearer header only for a real key", () => {
  const anonymous = builtinMcpConfig("context7", {}) as Record<string, unknown>
  expect(anonymous).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp", oauth: false })
  expect((builtinMcpConfig("context7", { CONTEXT7_API_KEY: "Your API Key" }) as Record<string, unknown>).headers).toBeUndefined()
  expect((builtinMcpConfig("context7", { CONTEXT7_API_KEY: " ctx7-abc " }) as Record<string, unknown>).headers)
    .toEqual({ Authorization: "Bearer ctx7-abc" })
  expect(builtinMcpConfig("grep_app") as Record<string, unknown>).toEqual({ type: "remote", url: "https://mcp.grep.app", oauth: false })
})

test("built-in servers register by default and never overwrite a user-defined name", async () => {
  const user = { type: "remote", url: "https://example.test/mcp", oauth: false } as Config
  const fixture = mcpRegistry({ context7: user })
  const result = await Effect.runPromise(Effect.scoped(registerMcps(fixture.ctx, parseOptions({}).mcps, {})))
  expect(result).toEqual({ registered: ["grep_app"], deferred: ["context7"] })
  expect(fixture.servers.get("context7")).toBe(user)
  expect((fixture.servers.get("grep_app") as Record<string, unknown>).url).toBe("https://mcp.grep.app")
})

test("mcps option selects servers and rejects unknown names", async () => {
  expect(parseOptions({}).mcps).toEqual([...MCP_NAMES])
  expect(parseOptions({ mcps: ["context7"] }).mcps).toEqual(["context7"])
  expect(() => parseOptions({ mcps: ["github"] })).toThrow(/mcps must contain only/)
  const fixture = mcpRegistry()
  expect(await Effect.runPromise(Effect.scoped(registerMcps(fixture.ctx, parseOptions({ mcps: [] }).mcps, {})))).toEqual({ registered: [], deferred: [] })
  expect(fixture.servers.size).toBe(0)
})

test("read-only specialists may call context7 and grep_app tools but nothing else new", async () => {
  const agents = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: (id) => agents.get(id), default: () => {}, remove: (id) => { agents.delete(id) },
    update: (id, update) => { const value = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id)); update(value); agents.set(id, value) },
  }
  await Effect.runPromise(Effect.scoped(registerAgents({ agent: { transform: (run) => Effect.sync(() => { run(editor); return { dispose: Effect.void } }) } }, parseOptions({}))))
  const rules = agents.get("librarian")!.permissions as readonly PermissionRule[]
  expect(evaluate("context7_resolve-library-id", "*", rules)).toBe("allow")
  expect(evaluate("context7_query-docs", "*", rules)).toBe("allow")
  expect(evaluate("grep_app_searchGitHub", "*", rules)).toBe("allow")
  expect(evaluate("shell", "*", rules)).toBe("deny")
  expect(evaluate("github_create_issue", "*", rules)).toBe("deny")
})
