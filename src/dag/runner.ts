import { Agent, Model } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { DagExecutionRef, DagNodeDefinition, JsonValue } from "./types"

export interface DagExecutionResult {
  readonly payload: JsonValue
}

export interface DagRunner {
  start(input: { readonly node: DagNodeDefinition; readonly prompt: string; readonly attempt: number }): Promise<DagExecutionRef>
  wait(ref: DagExecutionRef): Promise<DagExecutionResult>
  cancel(ref: DagExecutionRef): Promise<void>
}

function assistantText(messages: readonly unknown[]): string {
  for (const raw of [...messages].reverse()) {
    if (!raw || typeof raw !== "object") continue
    const message = raw as { type?: unknown; content?: unknown }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text)
      .join("\n")
    if (text) return text
  }
  return ""
}

export function createOpenCodeDagRunner(ctx: Pick<Context, "session"> & { readonly location: { readonly directory: string } }): DagRunner {
  return {
    async start(input) {
      if (input.node.agent === undefined) throw new Error(`Iolaus DAG node ${input.node.id} has no execution target`)
      const session = await ctx.session.create({
        title: `Iolaus DAG · ${input.node.id}`,
        agent: Agent.ID.make(input.node.agent),
        ...(input.node.model === undefined ? {} : { model: Model.Ref.parse(input.node.model) }),
        location: { directory: ctx.location.directory },
        metadata: { iolaus_dag_node: input.node.id, iolaus_dag_attempt: input.attempt },
      })
      await ctx.session.prompt({ sessionID: session.id, text: input.prompt, delivery: "queue" })
      return { nodeID: input.node.id, attempt: input.attempt, sessionID: String(session.id) }
    },
    async wait(ref) {
      await ctx.session.wait({ sessionID: ref.sessionID })
      const session = await ctx.session.get({ sessionID: ref.sessionID })
      const messages = await ctx.session.context({ sessionID: ref.sessionID })
      if (session.outcome === "failed") throw new Error("Iolaus DAG child session failed")
      if (session.outcome === "interrupted") throw new Error("Iolaus DAG child session was interrupted")
      return { payload: { text: assistantText(messages) } }
    },
    async cancel(ref) {
      await ctx.session.interrupt({ sessionID: ref.sessionID, resume: false })
    },
  }
}
