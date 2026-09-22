import type { Context as EffectContext } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Tool } from "@opencode/schema/tool"

import { createBtwTools } from "./tools"
import { BTW_BLOCKED_TOOLS, registerBtwToolGuard } from "./tool-guard"
import { loadOpenCode2Config } from "../../config"
import type { ChildSessionDeps } from "../../orchestration/child-session"
import type { Executor } from "../../orchestration/execution/types"
import { createNativeBtwTools } from "./native-tools"

type Trace = (event: string, detail?: Record<string, unknown>) => void

export interface RegisterBtwOptions {
  readonly cwd: string
  readonly deps: ChildSessionDeps
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: Trace
}

export interface BtwRegistration {
  readonly dispose: () => void
}

export type RegisterNativeBtwOptions = {
  readonly config: { readonly enabled?: boolean }
  readonly disabledHooks?: readonly string[]
  readonly executor: Executor
  readonly agent?: Agent.ID
  readonly model?: Model.Ref
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: Trace
}

export const registerBtwFeatureEffect = Effect.fn("omo.registerBtwFeatureEffect")(function* (ctx: EffectContext, options: RegisterNativeBtwOptions) {
  if (options.config.enabled !== true || options.disabledHooks?.includes("btw") === true) return
  if (!options.agent || !options.model) return
  const blocked = (name: string) => BTW_BLOCKED_TOOLS.has(name) || name.startsWith("team_")
    || ["workflow", "subagent", "write", "edit", "patch", "hashline_edit", "shell", "execute"].includes(name)
  yield* ctx.session.hook("context", (event) => Effect.gen(function* () {
    const record = yield* options.executor.managed(event.sessionID)
    if (record?.owner.kind !== "btw") return
    const removed = Object.keys(event.tools).filter(blocked)
    for (const name of removed) delete event.tools[name]
    options.trace?.("omo.btw.tools-blocked", { sessionID: event.sessionID, removed })
  }))
  yield* ctx.tool.hook("execute.before", (event) => Effect.gen(function* () {
    if (!blocked(event.tool)) return
    const record = yield* options.executor.managed(event.sessionID)
    if (record?.owner.kind === "btw") return yield* new Tool.Error({ message: "BTW side conversations cannot mutate state or delegate work" })
  }))
  const tools = createNativeBtwTools({
    executor: options.executor, cwd: ctx.location.directory,
    agent: options.agent, model: options.model, resolveSessionID: options.resolveSessionID, trace: options.trace,
  })
  yield* ctx.tool.transform((editor) => {
    editor.add({ name: "btw_start", description: "Start a bounded BTW side conversation.", input: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false }, options: { codemode: false }, execute: (input: unknown, caller: unknown) => tools.start(input, caller) })
    editor.add({ name: "btw_reply", description: "Continue an existing BTW side conversation.", input: { type: "object", properties: { side_session_id: { type: "string" }, text: { type: "string" } }, required: ["side_session_id", "text"], additionalProperties: false }, options: { codemode: false }, execute: (input: unknown, caller: unknown) => tools.reply(input, caller) })
    editor.add({ name: "btw_list", description: "List BTW side conversations.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false }, execute: (input: unknown, caller: unknown) => tools.list(caller) })
  })
  options.trace?.("omo.btw.native-registered", { tools: ["btw_start", "btw_reply", "btw_list"] })
})

/**
 * Registers the BTW side-conversation tools (btw_start / btw_reply /
 * btw_list) plus the context-hook guard that blocks delegation tools inside
 * side sessions. Gated on `btw.enabled` under `[opencode2]` (default off);
 * `disabled_hooks` respects the name `btw`.
 */
export async function registerBtwFeature(
  ctx: Context,
  options: RegisterBtwOptions,
): Promise<BtwRegistration | undefined> {
  const loaded = loadOpenCode2Config({ directory: options.cwd, options: { ...ctx.options } })
  const disabled = loaded.config.disabled_hooks?.includes("btw") === true
  if (!loaded.config.btw?.enabled || disabled) {
    options.trace?.("omo.btw.disabled", {
      reason: disabled ? "listed in disabled_hooks" : "btw.enabled is not true",
    })
    return undefined
  }

  await registerBtwToolGuard(ctx, options.trace)

  const tools = createBtwTools({
    ctx,
    deps: options.deps,
    cwd: options.cwd,
    resolveSessionID: options.resolveSessionID,
    trace: options.trace,
  })

  await ctx.tool.transform((draft) => {
    for (const tool of tools) {
      draft.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { codemode: false },
        execute: tool.execute,
      })
    }
  })

  options.trace?.("omo.btw.registered", { tools: tools.map((tool) => tool.name) })
  return { dispose: () => undefined }
}
