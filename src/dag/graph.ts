import { validateCondition } from "./condition"
import { DagValidationError } from "./graph-error"
import type { DagDefinition, DagNodeDefinition } from "./types"

export { DagValidationError }

export function isGate(node: DagNodeDefinition): boolean {
  return node.kind === "gate"
}

export function isJudge(node: DagNodeDefinition): boolean {
  return node.kind === "judge"
}

export function validateDefinition(definition: DagDefinition): void {
  if (definition.schemaVersion !== 1) throw new DagValidationError("Unsupported DAG schema version")
  if (!definition.name.trim()) throw new DagValidationError("DAG name must be nonempty")
  if (definition.nodes.length === 0) throw new DagValidationError("DAG must contain at least one node")
  const nodes = new Map<string, DagNodeDefinition>()
  for (const node of definition.nodes) {
    if (!node.id.trim()) throw new DagValidationError("DAG node id must be nonempty")
    if (nodes.has(node.id)) throw new DagValidationError(`Duplicate DAG node: ${node.id}`)
    if (node.kind !== undefined && node.kind !== "agent" && node.kind !== "judge" && node.kind !== "gate") throw new DagValidationError(`Unsupported node kind: ${node.id}`)
    if (isGate(node)) {
      if (node.agent !== undefined || node.model !== undefined) throw new DagValidationError(`Gate node must not name an agent or model: ${node.id}`)
      if (!node.prompt.trim()) throw new DagValidationError(`Gate node needs a message for the approver: ${node.id}`)
    } else {
      if (!node.agent?.trim()) throw new DagValidationError(`Invalid execution target: ${node.id}`)
      if (node.model !== undefined && !node.model.includes("/")) throw new DagValidationError(`Invalid model reference: ${node.id}`)
    }
    if (node.maxAttempts !== undefined && (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1)) {
      throw new DagValidationError(`Invalid maxAttempts for node: ${node.id}`)
    }
    nodes.set(node.id, node)
  }
  for (const node of definition.nodes) {
    if (node.dependsOn.includes(node.id)) throw new DagValidationError(`Self dependency: ${node.id}`)
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) throw new DagValidationError(`Unknown dependency: ${dependency}`)
    }
    if (node.when) validateCondition(node.when, node.id, new Set(node.dependsOn))
    for (const input of node.inputs ?? []) {
      if (input.node === "*") {
        if (node.dependsOn.length === 0) throw new DagValidationError(`Fan-in binding "*" requires dependsOn: ${node.id}`)
        continue
      }
      if (!nodes.has(input.node)) throw new DagValidationError(`Unknown input node: ${input.node}`)
    }
  }
  if (definition.loop) {
    const loop = definition.loop
    if (!nodes.has(loop.review)) throw new DagValidationError(`Loop review node is unknown: ${loop.review}`)
    if (!nodes.has(loop.fix)) throw new DagValidationError(`Loop fix node is unknown: ${loop.fix}`)
    if (!Number.isInteger(loop.maxRounds) || loop.maxRounds < 1 || loop.maxRounds > 10) throw new DagValidationError("Loop maxRounds must be an integer from 1 to 10")
    for (const id of loop.tail ?? []) if (!nodes.has(id)) throw new DagValidationError(`Loop tail node is unknown: ${id}`)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DagValidationError(`Cycle detected at node: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of nodes.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of definition.nodes) visit(node.id)
}

/**
 * A skipped upstream is settled, not a failure: a conditional branch that did
 * not fire must not block the rest of the graph. Downstream nodes that need
 * its output guard themselves with `when: {node, exists: true}`.
 */
export function dependencyState(
  node: DagNodeDefinition,
  records: ReadonlyMap<string, { readonly status: string }>,
): "ready" | "waiting" | "blocked" {
  let waiting = false
  for (const dependency of node.dependsOn) {
    const record = records.get(dependency)
    if (!record) throw new DagValidationError(`Missing dependency record: ${dependency}`)
    if (record.status === "failed" || record.status === "cancelled" || record.status === "blocked" || record.status === "interrupted") return "blocked"
    if (record.status !== "completed" && record.status !== "reused" && record.status !== "skipped") waiting = true
  }
  return waiting ? "waiting" : "ready"
}
