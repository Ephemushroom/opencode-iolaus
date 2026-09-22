import type { Context } from "@opencode/plugin/promise/plugin"
import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"

import type { TaskRecord, TaskRegistry } from "./task-registry"
import type { ConcurrencyLimiter } from "./concurrency"

export interface ChildResult {
  ok: boolean
  text: string
  taskID: string
  childSessionID?: string
  retriedModel?: string
}

export interface WaitChildOptions {
  sessionID: string
  timeoutMs: number
}

export interface ChildSessionDeps {
  /** Registers a waiter for a child session and resolves on terminal events. */
  waitChild: (options: WaitChildOptions) => Promise<{ ok: boolean; text: string }>
  /** Interrupts a stuck child session. */
  interrupt: (sessionID: string) => Promise<void>
}

export interface RunChildSessionOptions {
  ctx: Context
  registry: TaskRegistry
  limiter: ConcurrencyLimiter
  deps: ChildSessionDeps
  parentSessionID: string
  agent: string
  model: string
  prompt: string
  description: string
  /** When true, register the task in the background and return immediately. */
  background: boolean
  /** When set, continue an existing child session instead of creating one. */
  continuationTaskID?: string
  timeoutMs?: number
}

const DEFAULT_CHILD_TIMEOUT_MS = 120_000
const MAX_RETRIES = 1

/**
 * Executes one delegated task against a fresh (or continued) child session.
 *
 * Flow (plan 6.3):
 *   acquire concurrency slot -> create/continue child -> prompt -> wait for a
 *   terminal execution event (event pump aggregates text.ended/reasoning.ended)
 *   -> release slot.
 *
 * Sync mode waits and returns the aggregated output. Background mode registers
 * the task in the registry and returns immediately; the event pump completes it
 * and the plugin's completion notifier sends a synthetic wake to the parent.
 *
 * On execution failure with a retryable model, the child is recreated on the
 * next fallback-chain model once (MAX_RETRIES).
 */
export async function runChildSession(options: RunChildSessionOptions): Promise<ChildResult> {
  const { ctx, registry, limiter, deps, parentSessionID, agent, model, prompt, description, background } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS

  // Continuation: reuse the existing child session id from the task record.
  if (options.continuationTaskID) {
    const existing = registry.get(options.continuationTaskID)
    if (!existing || !existing.childSessionID) {
      return { ok: false, text: `task ${options.continuationTaskID} has no child session to continue`, taskID: options.continuationTaskID }
    }
    const result = await promptChildAndWait({
      ctx,
      registry,
      limiter,
      deps,
      task: existing,
      childSessionID: existing.childSessionID,
      prompt,
      timeoutMs,
      background,
    })
    return { ...result, taskID: existing.id, childSessionID: existing.childSessionID }
  }

  const task = registry.create({ parentSessionID, agent, model, description, background })

  await limiter.acquire(model)
  try {
    let currentModel = model
    let retriedModel: string | undefined
    let attempt = 0
    for (;;) {
      const [providerID, ...modelParts] = currentModel.split("/")
      const modelRef = providerID && modelParts.length > 0
        ? { id: modelParts.join("/"), providerID }
        : undefined
      const child = await ctx.session.create({
        agent,
        model: modelRef,
        title: description,
      })
      registry.update(task.id, { childSessionID: child.id, status: "running" })

      const result = await promptChildAndWait({
        ctx,
        registry,
        limiter,
        deps,
        task,
        childSessionID: child.id,
        prompt,
        timeoutMs,
        background,
      })
      if (result.ok || attempt >= MAX_RETRIES || background) {
        return { ...result, taskID: task.id, childSessionID: child.id, retriedModel }
      }

      // Execution failed: try the next fallback-chain model once.
      const nextModel = nextFallbackModel(agent, currentModel)
      if (!nextModel) {
        return { ...result, taskID: task.id, childSessionID: child.id }
      }
      retriedModel = nextModel
      currentModel = nextModel
      attempt += 1
      registry.update(task.id, { model: nextModel })
    }
  } finally {
    limiter.release(model)
  }
}

async function promptChildAndWait(input: {
  ctx: Context
  registry: TaskRegistry
  limiter: ConcurrencyLimiter
  deps: ChildSessionDeps
  task: TaskRecord
  childSessionID: string
  prompt: string
  timeoutMs: number
  background: boolean
}): Promise<{ ok: boolean; text: string }> {
  const { ctx, registry, deps, task, childSessionID, prompt, timeoutMs, background } = input

  let waiter: { ok: boolean; text: string } | undefined
  const waitPromise = deps.waitChild({ sessionID: childSessionID, timeoutMs }).then((result) => {
    waiter = result
    return result
  })

  await ctx.session.prompt({ sessionID: childSessionID, text: prompt })
  const result = await waitPromise

  // Sync mode: task is done when the child execution settles.
  if (!background) {
    if (result.ok) registry.complete(task.id)
    else registry.fail(task.id, result.text || "child session failed")
    return result
  }

  // Background mode: keep the task alive; the completion notifier (driven by
  // the event pump on execution.succeeded) marks it completed. If it already
  // failed, record it.
  if (!result.ok) {
    registry.fail(task.id, result.text || "child session failed")
  } else {
    registry.complete(task.id)
  }
  return result
}

/**
 * Finds the next fallback-chain model after the current one for an agent.
 * Returns undefined when the chain is exhausted or the agent has no chain.
 */
export function nextFallbackModel(agent: string, currentModel: string): string | undefined {
  const requirement = AGENT_MODEL_REQUIREMENTS[agent]
  const chain = requirement?.fallbackChain
  if (!chain || chain.length === 0) return undefined

  const currentProvider = currentModel.split("/")[0]
  const currentIndex = chain.findIndex((entry) =>
    entry.providers.some((provider) => provider === currentProvider),
  )
  const start = currentIndex >= 0 ? currentIndex + 1 : 0
  for (let index = start; index < chain.length; index += 1) {
    const entry = chain[index]
    if (entry && entry.providers.length > 0) {
      return `${entry.providers[0]}/${entry.model}`
    }
  }
  return undefined
}
