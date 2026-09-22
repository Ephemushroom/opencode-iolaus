import { loadOpenCode2Config } from "../../config"
import type { IdleInjectorTrace } from "../../orchestration/idle-injector"
import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import type { TodoItem } from "../../orchestration/todo-store"

import { registerTodoContinuation } from "./register"
import type { RegisteredTodoContinuation, TodoContinuationContext } from "./register"

export type ConfiguredTodoContinuationContext = TodoContinuationContext & {
  readonly options: Readonly<Record<string, unknown>>
}

export type RegisterConfiguredTodoContinuationOptions = {
  readonly directory: string
  readonly getTodos: (sessionID: string) => readonly TodoItem[]
  readonly gate: SessionDispatchGate
  readonly trace?: IdleInjectorTrace
}

export async function registerConfiguredTodoContinuation(
  ctx: ConfiguredTodoContinuationContext,
  options: RegisterConfiguredTodoContinuationOptions,
): Promise<RegisteredTodoContinuation> {
  const loaded = loadOpenCode2Config({
    directory: options.directory,
    options: { ...ctx.options },
  })
  const enabled = loaded.config.todo_continuation?.enabled === true
    && !loaded.config.disabled_hooks?.includes("todo-continuation")

  return registerTodoContinuation(ctx, {
    enabled,
    getTodos: options.getTodos,
    gate: options.gate,
    maxConsecutive: loaded.config.todo_continuation?.max_consecutive,
    trace: options.trace,
  })
}
