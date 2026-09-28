import { Effect } from "effect"
import { PRIMARY_AGENTS, agentName, categoryName, type AgentName } from "../prompts/catalog"
import type { DagDefinition, DagRunRecord } from "../dag/types"
import { DagValidationError } from "../dag/errors"

export interface TierSession {
  readonly agent?: unknown
  readonly parentID?: unknown
  readonly metadata?: Record<string, unknown>
}

export interface TierSource {
  readonly agent: string
  readonly primaryAllowed: boolean
  readonly atlasTicket: boolean
  readonly atlasPlan?: string
  readonly native: boolean
}

export function isTopLevel(session: TierSession): boolean {
  return session.parentID === undefined && session.metadata?.iolaus_dag_node === undefined
}

export function tierSource(sessionID: string, get: (id: string) => Effect.Effect<TierSession, DagValidationError>, linkedRun: (runID: string, nodeID: string, sessionID: string) => Effect.Effect<DagRunRecord | undefined>): Effect.Effect<TierSource, DagValidationError> {
  return Effect.gen(function* () {
    const session = yield* get(sessionID)
    const agent = String(session.agent ?? "")
    const ancestors: TierSession[] = []
    const links: (DagRunRecord | undefined)[] = []
    const seen = new Set([sessionID])
    let current = session
    let currentID = sessionID
    let parent: string | undefined
    while (true) {
      const runID = current.metadata?.iolaus_dag_run
      const nodeID = current.metadata?.iolaus_dag_node
      const link = typeof runID === "string" && typeof nodeID === "string"
        ? yield* linkedRun(runID, nodeID, currentID) : undefined
      const validLink = link?.nodes.some((node) => node.definition.id === nodeID && node.definition.agent === current.agent) ? link : undefined
      links.push(validLink)
      parent = typeof current.parentID === "string" ? current.parentID : validLink?.ownerSessionID
      if (!parent || seen.has(parent)) break
      seen.add(parent)
      current = yield* get(parent)
      ancestors.push(current)
      currentID = parent
    }
    const iolaus = (name: string) => agentName(name) !== undefined || categoryName(name) !== undefined
    const foreignAncestor = ancestors.some((ancestor) => {
      const name = String(ancestor.agent ?? "")
      return iolaus(name) && name !== agent
    })
    const direct = ancestors[0]
    const primaryAllowed = !foreignAncestor && (isTopLevel(session) || (direct !== undefined && String(direct.agent ?? "") === agent))
    let atlasPlan: string | undefined
    if (agent === "atlas" && !foreignAncestor) for (const [index, candidate] of [session, ...ancestors].entries()) {
      if (String(candidate.agent ?? "") !== "atlas") continue
      const nodeID = candidate.metadata?.iolaus_dag_node
      const run = links[index]
      if (run?.authorizedPlan && run.nodes.some((node) => node.definition.id === nodeID && node.definition.agent === "atlas")) {
        atlasPlan = run.authorizedPlan
        break
      }
    }
    const atlasTicket = atlasPlan !== undefined
    return { agent, primaryAllowed: primaryAllowed || atlasTicket, atlasTicket, ...(atlasPlan ? { atlasPlan } : {}), native: !iolaus(agent) && session.metadata?.iolaus_dag_node === undefined && !ancestors.some((ancestor) => iolaus(String(ancestor.agent ?? ""))) }
  })
}

export function tierDenial(source: TierSource, target: string, authorizedPlan?: string): string | undefined {
  if (!PRIMARY_AGENTS.has(target as AgentName) || source.native) return undefined
  if (source.agent === target && source.primaryAllowed && (target !== "atlas" || source.atlasTicket || authorizedPlan !== undefined)) return undefined
  return `Agent tier boundary: ${source.agent || "unknown"} cannot delegate to primary ${target}`
}

export function subagentTargets(input: { readonly agent?: unknown; readonly sessionID?: unknown }, get: (id: string) => Effect.Effect<TierSession, DagValidationError>): Effect.Effect<readonly string[], DagValidationError> {
  const supplied = typeof input.agent === "string" ? input.agent : ""
  if (typeof input.sessionID === "string") return get(input.sessionID).pipe(Effect.map((session) => [String(session.agent ?? ""), supplied]))
  return Effect.succeed([supplied])
}

export function admitTier(source: TierSource, session: TierSession, definition: DagDefinition, authorizedPlan?: string): void {
  if (authorizedPlan && (source.agent !== "atlas" || !isTopLevel(session)))
    throw new DagValidationError("/start-work requires a top-level Atlas session")
  for (const node of definition.nodes) {
    if (node.kind === "gate") continue
    const reason = tierDenial(source, node.agent ?? "", authorizedPlan)
    if (reason) throw new DagValidationError(reason)
  }
}
