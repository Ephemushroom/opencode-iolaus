import { createHash } from "node:crypto"
import { canonicalJson } from "./canonical-json"
import type { DagDefinition, DagNodeDefinition } from "./types"

function normalizedNode(node: DagNodeDefinition): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind ?? "agent",
    agent: node.agent ?? null,
    model: node.model ?? null,
    prompt: node.prompt,
    when: node.when ?? null,
    dependsOn: [...node.dependsOn].sort(),
    inputs: [...(node.inputs ?? [])]
      .map((input) => ({ node: input.node, field: input.field ?? "payload" }))
      .sort((left, right) => `${left.node}:${left.field}`.localeCompare(`${right.node}:${right.field}`)),
    maxAttempts: node.maxAttempts ?? 1,
  }
}

export function normalizedDefinition(definition: DagDefinition): unknown {
  return {
    schemaVersion: definition.schemaVersion,
    name: definition.name,
    maxParallel: definition.maxParallel ?? 4,
    nodes: [...definition.nodes].sort((left, right) => left.id.localeCompare(right.id)).map(normalizedNode),
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function graphFingerprint(definition: DagDefinition): string {
  return fingerprint(normalizedDefinition(definition))
}

export function nodeFingerprint(node: DagNodeDefinition, upstream: readonly string[] = []): string {
  return fingerprint({ node: normalizedNode(node), upstream: [...upstream].sort() })
}
