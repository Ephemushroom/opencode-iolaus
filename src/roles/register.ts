import type { SessionStateStore } from "../database"
import { Cause, Effect, Exit, Stream, type Scope } from "effect"
import { Agent } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import type { Options } from "../options"
import type { DagController } from "../dag/controller"
import { DAG_CHILD_MARKER } from "../prompts/mode-dag"
import { agentName, categoryName } from "../prompts/catalog"
import { COMMAND_OWNERS, commandMarker, parseCommand } from "./command"
import { createGoalRuntime, createGoalTools, extendGoal, readGoal, saveGoal, setGoal, updateGoal } from "./goal"
import { denial, inheritPlanning, resolvePolicy, type RoleRecord } from "./guard"
import { loadPlan, PLANNING_MARKER, PLANS_DIR, resolvePlan } from "./plan"
import { compilePlan, gitHead, parseStartWork, type Delivery } from "./startwork"
import { copyInto, defaultWorktreePath, ensureWorktree, repositoryRoot } from "../dag/worktree"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { isTopLevel, subagentTargets, tierDenial, type TierSource } from "./tier"
import { DagValidationError } from "../dag/errors"

type Trace = (event: string, data?: Record<string, unknown>) => void

export interface RoleHost {
  readonly controller: DagController
  readonly source: (sessionID: string) => Effect.Effect<TierSource, DagValidationError>
  /** Where plans are read: the session's directory. */
  readonly directory: (sessionID: string) => Effect.Effect<string>
  readonly state: SessionStateStore
  readonly trace: Trace
}

export function readRole(state: SessionStateStore, sessionID: string): RoleRecord | undefined {
  const role = state.read("role", sessionID) as RoleRecord | undefined
  return role !== undefined && role !== null && ["planning", "ticket", "orchestrator"].includes(role.role) ? role : undefined
}

export function saveRole(state: SessionStateStore, sessionID: string, role: RoleRecord): void {
  state.save("role", sessionID, role)
}

type SessionInfo = { readonly agent?: unknown; readonly parentID?: unknown; readonly metadata?: Record<string, unknown> }

/** A goal loops only in a top-level Hephaestus session: not a subagent, not a DAG node. */
export function isGoalSessionInfo(session: SessionInfo): boolean {
  return String(session.agent ?? "") === "hephaestus" && session.parentID === undefined && session.metadata?.iolaus_dag_node === undefined
}

/**
 * Wires the role policy into the host: the prompt hook switches a command's session
 * to its owning agent only at the top level, records planning and trusted ticket roles, starts /start-work runs and
 * sets Hephaestus goals; the tool hook enforces the policy before every tool call;
 * the event stream drives the goal loop.
 */
export function registerRoles(ctx: Context, options: Options, host: RoleHost): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { state, trace } = host
    const sessionInfo = (sessionID: string) => ctx.session.get({ sessionID: sessionID as never }).pipe(
      Effect.map((session) => session as unknown as SessionInfo),
      Effect.catch(() => Effect.succeed(undefined as SessionInfo | undefined)))
    const isGoalSession = (sessionID: string) => options.agents.includes("hephaestus")
      ? sessionInfo(sessionID).pipe(Effect.map((session) => session !== undefined && isGoalSessionInfo(session)))
      : Effect.succeed(false)

    yield* ctx.session.hook("prompt", (event) => Effect.gen(function* () {
      const text = event.prompt.text ?? ""
      const sessionID = String(event.sessionID)
      const session = yield* sessionInfo(sessionID)
      if (!session) return
      if (text.includes(PLANNING_MARKER) && !isTopLevel(session)) {
        saveRole(state, sessionID, { role: "planning" })
        trace("iolaus.role.recorded", { sessionID, role: "planning" })
      }
      const ticket = String(session.agent ?? "") === "atlas" && !isTopLevel(session)
        ? (yield* host.source(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined))))?.atlasPlan : undefined
      if (ticket) {
        saveRole(state, sessionID, { role: "ticket", plan: ticket })
        trace("iolaus.role.recorded", { sessionID, role: "ticket", plan: ticket })
      }
      // DAG workers and planning consults carry markers of their own; their text is never a user command.
      if (!isTopLevel(session) || ticket || text.includes(PLANNING_MARKER) || text.includes(DAG_CHILD_MARKER)) return
      let agent = String(session.agent ?? "")
      const command = parseCommand(text)
      const owner = command && command.name in COMMAND_OWNERS ? COMMAND_OWNERS[command.name as keyof typeof COMMAND_OWNERS] : undefined
      if (owner && options.agents.includes(owner) && agent !== owner) {
        const switched = yield* Effect.exit(ctx.session.switchAgent({ sessionID: event.sessionID, agent: Agent.ID.make(owner) }))
        // Only the agent changes: the session keeps the model the user chose, whatever the owner's pinned lane model.
        trace("iolaus.command.agent", { sessionID, command: command!.name, from: agent || null, to: owner, ok: Exit.isSuccess(switched) })
        if (Exit.isSuccess(switched)) agent = owner
      }
      if (command?.name === "start-work" && agent === "atlas") {
        const directory = yield* host.directory(sessionID)
        const reject = (errors: readonly string[]) => {
          event.prompt.text = `${commandMarker("start-work")}\n/start-work did not start. Tell the user what to fix and do not implement anything:\n${errors.map((error) => `- ${error}`).join("\n")}`
          trace("iolaus.startwork.rejected", { sessionID, errors })
        }
        const parsed = parseStartWork(command.args)
        if (!parsed.ok) return reject([parsed.error])
        const result = resolvePlan(directory, parsed.args.plan)
        if (!result.ok) return reject(result.errors)
        let delivery: Delivery | undefined
        if (parsed.args.worktree) {
          const root = repositoryRoot(directory)
          if (!root) return reject([`--worktree needs a git repository; ${directory} is not one`])
          const branch = `iolaus/${result.plan.slug.replace(/[^a-z0-9._-]/g, "-")}`
          const path = parsed.args.worktreePath ? resolve(directory, parsed.args.worktreePath.replace(/^~(?=\/|$)/, homedir())) : defaultWorktreePath(root, result.plan.slug)
          // Plans live under a git-ignored directory, so the worktree gets a copy: its ticket sessions read and validate it there.
          const made = yield* Effect.exit(Effect.try(() => { ensureWorktree(directory, path, branch); copyInto(directory, path, `${PLANS_DIR}/${result.plan.slug}`) }))
          if (Exit.isFailure(made)) return reject([String((Cause.squash(made.cause) as Error)?.message ?? "the worktree could not be created").replace(/^.*?: /, "")])
          delivery = { directory: path, branch, root, pr: parsed.args.makePr, ship: parsed.args.ship }
          trace("iolaus.startwork.worktree", { sessionID, path, branch, pr: delivery.pr, ship: delivery.ship })
        }
        const created = yield* Effect.exit(host.controller.create(compilePlan(result.plan, gitHead(delivery?.directory ?? directory), delivery), sessionID, result.plan.slug))
        if (Exit.isFailure(created)) {
          const message = Cause.squash(created.cause) instanceof Error ? (Cause.squash(created.cause) as Error).message : "the run could not be created"
          event.prompt.text = `${commandMarker("start-work")}\n/start-work did not start: ${message}. Tell the user; do not implement anything.`
          trace("iolaus.startwork.rejected", { sessionID, errors: [message] })
          return
        }
        const run = created.value
        saveRole(state, sessionID, { role: "orchestrator", plan: result.plan.slug, runID: run.runID })
        trace("iolaus.startwork.started", { sessionID, plan: result.plan.slug, runID: run.runID, tickets: result.plan.tickets.map((t) => t.id) })
        const where = delivery ? ` in the worktree ${delivery.directory} on branch ${delivery.branch}` : ""
        const after = delivery?.ship ? " After approval Atlas opens the PR, watches CI until it passes, merges it and removes the worktree." : delivery?.pr ? " After approval Atlas opens the PR; report its URL." : ""
        event.prompt.text = `${commandMarker("start-work")}\nIolaus started run ${run.runID} for plan "${result.plan.slug}"${where}: ${result.plan.tickets.length} ticket(s), each in its own Atlas session, then Standards and Spec reviews, a fix pass if either fails, and an accept gate.${after} Call iolaus_flow with action "wait" and run_id "${run.runID}". When it pauses at the accept gate, show the user both reviews and ask for their decision.`
        return
      }
      if (agent !== "hephaestus" || !isGoalSessionInfo({ ...session, agent })) return
      if (command?.name === "goal") {
        const goal = command.args ? setGoal(state, sessionID, command.args) : readGoal(state, sessionID) ? updateGoal(state, sessionID, "active") : null
        trace("iolaus.goal.set", { sessionID, via: "command", active: goal?.status === "active" })
        return
      }
      if (command) return
      extendGoal(state, sessionID, text)
      trace("iolaus.goal.set", { sessionID, via: "prompt" })
    }))

    const runtime = createGoalRuntime({
      read: (sessionID) => readGoal(state, sessionID),
      save: (goal) => saveGoal(state, goal),
      isGoalSession: (sessionID) => Effect.runPromise(isGoalSession(sessionID)),
      dispatch: (sessionID, text) => Effect.runPromise(ctx.session.synthetic({ sessionID: sessionID as never, text, delivery: "queue", resume: true }).pipe(Effect.asVoid)),
      settle: () => new Promise((done) => setTimeout(done, 150)),
      trace,
    })

    yield* ctx.tool.hook("execute.before", (event) => Effect.gen(function* () {
      const sessionID = String(event.sessionID)
      runtime.toolCalled(sessionID)
      const agent = String(event.agent)
      const role = readRole(state, sessionID)
      if (event.tool === "subagent") {
        const input = event.input as { agent?: unknown; sessionID?: unknown }
        const targets = yield* subagentTargets(input, (id) => ctx.session.get({ sessionID: id as never }).pipe(
          Effect.map((session) => session as SessionInfo), Effect.mapError(() => new DagValidationError("Subagent continuation target is unavailable")))).pipe(
          Effect.catch(() => Effect.fail(new Tool.Error({ message: "[iolaus tier] Subagent continuation target is unavailable" }))))
        const caller = yield* host.source(sessionID).pipe(Effect.catch(() => Effect.fail(new Tool.Error({ message: "[iolaus tier] Caller ancestry is unavailable" }))))
        if (targets.every((target) => !target) && !caller.native) return yield* Effect.fail(new Tool.Error({ message: "[iolaus tier] Subagent target agent is required" }))
        const reason = targets.map((target) => tierDenial(caller, target)).find(Boolean)
        if (reason) return yield* Effect.fail(new Tool.Error({ message: `[iolaus tier] ${reason}` }))
      }
      if (role?.role !== "planning" && !agentName(agent) && !categoryName(agent)) return
      const directory = yield* host.directory(sessionID)
      const ticket = role?.role === "ticket" && role.plan !== undefined
        && (yield* host.source(sessionID).pipe(Effect.map((source) => source.atlasPlan === role.plan), Effect.catch(() => Effect.succeed(false))))
      const policy = resolvePolicy(agent, role, Boolean(ticket) && role?.plan !== undefined && loadPlan(directory, role.plan).ok)
      const reason = denial(policy, event.tool, event.input, directory)
      if (reason) {
        trace("iolaus.role.blocked", { sessionID, agent, policy, tool: event.tool })
        return yield* Effect.fail(new Tool.Error({ message: `[iolaus ${policy}] ${reason}` }))
      }
      if ((policy === "planner" || policy === "planning") && inheritPlanning(event.tool, event.input)) {
        trace("iolaus.role.inherited", { sessionID, agent, tool: event.tool })
      }
    }))

    if (options.agents.includes("hephaestus")) {
      const tools = createGoalTools(state, isGoalSession, trace)
      yield* ctx.tool.transform((editor) => { for (const tool of tools) editor.add(tool) })
      yield* Effect.forkScoped(Stream.runForEach(ctx.event.subscribe(), (event) =>
        Effect.forkScoped(Effect.promise(() => runtime.handle(event))).pipe(Effect.asVoid)).pipe(
        Effect.catchCause((cause) => Effect.sync(() => trace("iolaus.goal.events-stopped", { cause: String(cause) })))))
    }
    trace("iolaus.roles.registered", { goal: options.agents.includes("hephaestus"), startWork: options.agents.includes("atlas") })
  })
}
