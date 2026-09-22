import { describe, expect, test } from "bun:test"
import { Agent, Model } from "@opencode/plugin"
import type { CommandDefinition, CommandEditor, CommandInvocation } from "@opencode/plugin/effect/command"
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { registerBuiltinCommands, type BuiltinCommandsRegistrationContext } from "./register-builtin-commands"

const EXPECTED_COMMANDS = ["goal", "refactor", "ulw-execute", "stop-continuation", "handoff", "remove-ai-slops", "hyperplan"]
const sessionID = Session.ID.make("ses_qa_command")
const atlasModel = Model.Ref.parse("qa/atlas-model#high")

function fixture(agent = Agent.ID.make("sisyphus")) {
  const commands = new Map<string, CommandDefinition>()
  const events: string[] = []
  const prompts: Parameters<BuiltinCommandsRegistrationContext["session"]["prompt"]>[0][] = []
  const models: Parameters<BuiltinCommandsRegistrationContext["session"]["switchModel"]>[0]["model"][] = []
  const editor: CommandEditor = { add: (command) => { commands.set(command.name, command) } }
  const context: BuiltinCommandsRegistrationContext = {
    command: { transform: (callback) => Effect.sync(() => { callback(editor); return { dispose: Effect.void } }) },
    agent: { get: () => Effect.sync(() => { events.push("lookup"); return { data: { model: atlasModel } } }) },
    session: {
      get: () => Effect.sync(() => { events.push("get"); return { agent } }),
      switchAgent: (input) => Effect.sync(() => { events.push("agent"); expect(input.agent).toBe(Agent.ID.make("atlas")) }),
      switchModel: (input) => Effect.sync(() => { events.push("model"); models.push(input.model) }),
      prompt: (input) => Effect.sync(() => { events.push("prompt"); prompts.push(input) }),
    },
  }
  return { commands, context, events, prompts, models }
}

async function command(f: ReturnType<typeof fixture>, name: string) {
  await Effect.runPromise(Effect.scoped(registerBuiltinCommands(f.context)))
  const selected = f.commands.get(name)
  if (!selected) throw new Error(`Missing fixture command: ${name}`)
  return selected
}

describe("registerBuiltinCommands", () => {
  test("#given an add-only editor #when registering twice #then the seven commands are executable without session writes", async () => {
    const f = fixture()
    await Effect.runPromise(Effect.scoped(registerBuiltinCommands(f.context)))
    await Effect.runPromise(Effect.scoped(registerBuiltinCommands(f.context)))
    expect([...f.commands.keys()]).toEqual(EXPECTED_COMMANDS)
    for (const selected of f.commands.values()) expect(typeof selected.execute).toBe("function")
    expect(f.events).toEqual([])
  })

  test.each(["steer", "queue"] as const)("#given %s delivery and attachments #when invoking goal #then one unchanged envelope is submitted", async (delivery) => {
    const f = fixture()
    const selected = await command(f, "goal")
    const text = "$ARGUMENTS $SESSION_ID $TIMESTAMP $1 $& $$ !`not-a-command`"
    const input: CommandInvocation = {
      sessionID, delivery,
      prompt: { text, files: [{ uri: "file:///qa.txt" }], agents: [{ name: "explore" }], skills: [{ id: Skill.ID.make("qa-skill") }] },
    }
    const original = structuredClone(input)
    await Effect.runPromise(selected.execute(input))
    expect(f.events).toEqual(["prompt"])
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]?.text).toContain(text)
    expect(f.prompts[0]).toMatchObject({ sessionID, delivery, files: input.prompt.files, agents: input.prompt.agents, skills: input.prompt.skills })
    expect(input).toEqual(original)
  })

  test.each(["sisyphus", "atlas"])("#given initial agent %s #when ulw-execute runs #then atlas model and variant are selected before submission", async (initial) => {
    const f = fixture(Agent.ID.make(initial))
    const selected = await command(f, "ulw-execute")
    await Effect.runPromise(selected.execute({ sessionID, delivery: "steer", prompt: { text: "qa-plan" } }))
    expect(f.events).toEqual(initial === "atlas" ? ["lookup", "get", "model", "prompt"] : ["lookup", "get", "agent", "model", "prompt"])
    expect(f.models).toEqual([atlasModel])
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]?.text).toContain("qa-plan")
    expect(f.prompts[0]?.text).toContain(sessionID)
  })

  test("#given an agent without a configured model #when selecting it #then the session model is not overwritten", async () => {
    const f = fixture()
    const selected = await command({ ...f, context: { ...f.context, agent: { get: () => Effect.succeed({ data: {} }) } } }, "ulw-execute")
    await Effect.runPromise(selected.execute({ sessionID, delivery: "queue", prompt: { text: "" } }))
    expect(f.models).toEqual([])
    expect(f.prompts).toHaveLength(1)
  })

  test("#given two explicit commands on one session #when invoked concurrently #then neither input is dropped", async () => {
    const f = fixture()
    const selected = await command(f, "goal")
    await Effect.runPromise(Effect.all(["first-payload", "second-payload"].map((text) => selected.execute({ sessionID, delivery: "queue", prompt: { text } })), { concurrency: "unbounded" }))
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[0]?.text).toContain("first-payload")
    expect(f.prompts[1]?.text).toContain("second-payload")
  })

  test("#given pending native admission #when a command executes #then its callback awaits that admission", async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<void>()
    const context = { ...f.context, session: { ...f.context.session, prompt: () => Effect.promise(() => deferred.promise) } }
    await Effect.runPromise(Effect.scoped(registerBuiltinCommands(context)))
    const selected = f.commands.get("goal")
    if (!selected) throw new Error("Missing goal")
    let settled = false
    const pending = Effect.runPromise(selected.execute({ sessionID, delivery: "steer", prompt: { text: "" } })).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    deferred.resolve()
    await pending
    expect(settled).toBe(true)
  })

  test.each(["lookup", "agent", "model", "prompt"])("#given %s rejection #when executing #then failure propagates without another submission", async (failure) => {
    const f = fixture()
    const rejected = () => Effect.fail(new Error("fixture rejection"))
    const context = {
      ...f.context,
      agent: failure === "lookup" ? { get: rejected } : f.context.agent,
      session: { ...f.context.session,
        switchAgent: failure === "agent" ? rejected : f.context.session.switchAgent,
        switchModel: failure === "model" ? rejected : f.context.session.switchModel,
        prompt: failure === "prompt" ? rejected : f.context.session.prompt,
      },
    }
    await Effect.runPromise(Effect.scoped(registerBuiltinCommands(context)))
    const selected = f.commands.get("ulw-execute")
    if (!selected) throw new Error("Missing ulw-execute")
    await expect(Effect.runPromise(selected.execute({ sessionID, delivery: "steer", prompt: { text: "qa" } }))).rejects.toThrow("fixture rejection")
    expect(f.prompts).toEqual([])
  })
})
