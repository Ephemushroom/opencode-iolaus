import { Effect } from "effect"
import { WorkflowError, type Node } from "./types"

export const validateGraph = Effect.fn("workflow.validateGraph")(function* (nodes: readonly Node[]) {
  if (nodes.length === 0) return yield* new WorkflowError({ code: "empty", message: "Workflow requires at least one node" })
  if (nodes.some((node) => node.id.trim().length === 0 || node.prompt.trim().length === 0)) {
    return yield* new WorkflowError({ code: "empty", message: "Workflow node id and prompt must be nonempty" })
  }
  if (nodes.length === 0) return yield* new WorkflowError({ code: "empty", message: "Workflow requires at least one node" })
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) return yield* new WorkflowError({ code: "duplicate", message: "Duplicate workflow node ID" })
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) return yield* new WorkflowError({ code: "self-dependency", message: `Node ${node.id} depends on itself` })
      if (!ids.has(dependency)) return yield* new WorkflowError({ code: "unknown-dependency", message: `Unknown dependency ${dependency}` })
    }
  }
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]))
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0)
    if (ready.length === 0) return yield* new WorkflowError({ code: "cycle", message: "Workflow contains a dependency cycle" })
    for (const [id] of ready) {
      remaining.delete(id)
      for (const dependencies of remaining.values()) dependencies.delete(id)
    }
  }
})
