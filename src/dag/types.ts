export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type DagNodeKind = "agent" | "aggregator"
export type DagRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"
export type DagNodeStatus =
  | "pending"
  | "ready"
  | "starting"
  | "running"
  | "completed"
  | "reused"
  | "failed"
  | "blocked"
  | "cancel_requested"
  | "cancelled"
  | "interrupted"
  | "needs_retry"

/**
 * Binds an upstream node result into this node's prompt. `node: "*"` expands to
 * every entry of `dependsOn`, which is the default fan-in shape: a downstream
 * Agent reads all parallel results with their provenance and synthesises them.
 */
export interface DagInputBinding {
  readonly node: string
  readonly field?: string
}

export interface DagResolvedInput {
  readonly node: string
  readonly field: string
  readonly value: JsonValue
  readonly provenance: {
    readonly agent: string
    readonly model: string
    readonly attempt: number
    readonly status: DagResultEnvelope["status"]
    readonly sessionID: string | null
  } | null
}

export interface DagNodeDefinition {
  readonly id: string
  readonly kind?: DagNodeKind
  readonly agent: string
  readonly model: string
  readonly prompt: string
  readonly dependsOn: readonly string[]
  readonly inputs?: readonly DagInputBinding[]
  readonly maxAttempts?: number
}

export interface DagDefinition {
  readonly schemaVersion: 1
  readonly name: string
  readonly nodes: readonly DagNodeDefinition[]
  readonly maxParallel?: number
}

export interface DagExecutionRef {
  readonly nodeID: string
  readonly attempt: number
  readonly sessionID: string
}

export interface DagResultEnvelope {
  readonly schemaVersion: 1
  readonly runID: string
  readonly nodeID: string
  readonly generation: number
  readonly attempt: number
  readonly status: "completed" | "failed" | "cancelled"
  readonly payload: JsonValue
  readonly provenance: {
    readonly parentNodeIDs: readonly string[]
    readonly execution?: DagExecutionRef
    readonly agent: string
    readonly model: string
  }
  readonly createdAt: number
}

export interface DagNodeRecord {
  readonly definition: DagNodeDefinition
  readonly fingerprint: string
  readonly status: DagNodeStatus
  readonly attempt: number
  readonly result?: DagResultEnvelope
  readonly error?: string
  readonly execution?: DagExecutionRef
  readonly createdAt?: number
  readonly updatedAt?: number
}

export interface DagRunRecord {
  readonly runID: string
  readonly ownerSessionID: string
  readonly name: string
  readonly definition: DagDefinition
  readonly fingerprint: string
  readonly generation: number
  readonly status: DagRunStatus
  readonly nodes: readonly DagNodeRecord[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DagEvent {
  readonly schemaVersion: 1
  readonly eventID: string
  readonly sequence: number
  readonly runID: string
  readonly nodeID?: string
  readonly generation: number
  readonly type:
    | "run.started"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "node.ready"
    | "node.started"
    | "node.completed"
    | "node.failed"
    | "node.blocked"
    | "node.retrying"
    | "node.reused"
  readonly payload?: JsonValue
  readonly createdAt: number
}

export interface DagAction {
  readonly actionID: string
  readonly runID: string
  readonly nodeID?: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly payload?: JsonValue
  readonly createdAt: number
}

export interface DagSnapshot {
  readonly run: DagRunRecord
  readonly events: readonly DagEvent[]
}
