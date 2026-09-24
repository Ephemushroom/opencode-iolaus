import type { DagDefinition, DagNodeDefinition } from "./types"

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DagValidationError"
  }
}

export function validateDefinition(definition: DagDefinition): void {
  if (definition.schemaVersion !== 1) throw new DagValidationError("Unsupported DAG schema version")
  if (!definition.name.trim()) throw new DagValidationError("DAG name must be nonempty")
  if (definition.nodes.length === 0) throw new DagValidationError("DAG must contain at least one node")
  const nodes = new Map<string, DagNodeDefinition>()
  for (const node of definition.nodes) {
    if (!node.id.trim()) throw new DagValidationError("DAG node id must be nonempty")
    if (nodes.has(node.id)) throw new DagValidationError(`Duplicate DAG node: ${node.id}`)
    if (!node.agent.trim() || !node.model.includes("/")) throw new DagValidationError(`Invalid execution target: ${node.id}`)
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
    for (const input of node.inputs ?? []) {
      if (!nodes.has(input.node)) throw new DagValidationError(`Unknown input node: ${input.node}`)
    }
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

export function dependencyState(
  node: DagNodeDefinition,
  records: ReadonlyMap<string, { readonly status: string }>,
): "ready" | "waiting" | "blocked" {
  let waiting = false
  for (const dependency of node.dependsOn) {
    const record = records.get(dependency)
    if (!record) throw new DagValidationError(`Missing dependency record: ${dependency}`)
    if (record.status === "failed" || record.status === "cancelled" || record.status === "blocked" || record.status === "interrupted") return "blocked"
    if (record.status !== "completed" && record.status !== "reused") waiting = true
  }
  return waiting ? "waiting" : "ready"
}
