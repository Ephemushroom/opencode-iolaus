import { Effect } from "effect"
import { Agent } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionStateStore } from "../database"
import type { DagNodeRecord } from "../dag/types"
import { DagValidationError } from "../dag/errors"
import { FLOW_TOOL_NAME } from "../dag/tool"
import { evaluate } from "../ast-grep/permissions"
import { denial, resolvePolicy } from "./guard"
import { readRole } from "./register"

export function rescueRoleAllowed(ctx: { readonly session: Pick<Context["session"], "get"> }, state: SessionStateStore, sessionID: string): Effect.Effect<boolean, DagValidationError> {
  return ctx.session.get({ sessionID: sessionID as never }).pipe(
    Effect.map((session) => !["atlas", "prometheus"].includes(String(session.agent ?? "")) && readRole(state, sessionID) === undefined),
    Effect.mapError(() => new DagValidationError("Rescue session role is unavailable")),
  )
}

export function admitSteering(ctx: { readonly session: Pick<Context["session"], "get">; readonly agent: Pick<Context["agent"], "get"> }, state: SessionStateStore, owner: string, node: DagNodeRecord): Effect.Effect<void, DagValidationError> {
  return Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID: owner as never }).pipe(Effect.mapError(() => new DagValidationError("Steering owner is unavailable")))
    const agent = String(session.agent ?? "")
    const role = readRole(state, owner)
    if (agent === "atlas" || role?.role === "ticket" || role?.role === "orchestrator") return yield* Effect.fail(new DagValidationError("Atlas sessions cannot steer live executions"))
    const reason = denial(resolvePolicy(agent, role, false), FLOW_TOOL_NAME, { action: "steer" }, String(session.location.directory))
    if (reason) return yield* Effect.fail(new DagValidationError(reason))
    if (node.execution && readRole(state, node.execution.sessionID)?.role === "planning") return yield* Effect.fail(new DagValidationError("Planning children cannot receive live steering"))
    const info = yield* ctx.agent.get({ agentID: Agent.ID.make(agent), location: { directory: String(session.location.directory) } }).pipe(Effect.mapError(() => new DagValidationError("Steering owner permissions are unavailable")))
    if (!info.data) return yield* Effect.fail(new DagValidationError("Steering owner permissions are unavailable"))
    const rules = [...info.data.permissions, ...(session.permissions ?? [])]
    if (evaluate(FLOW_TOOL_NAME, "*", rules) !== "allow" || evaluate("subagent", node.definition.agent ?? "", rules) !== "allow") {
      return yield* Effect.fail(new DagValidationError("Steering requires explicit flow and subagent delegation permission"))
    }
  })
}
