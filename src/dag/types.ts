export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * `agent` runs a child session; `judge` makes one model call with no session and
 * is the cheap shape for reviews; `gate` waits for a human.
 */
export type DagNodeKind = "agent" | "judge" | "aggregator" | "gate"
export type DagRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted"
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
  | "skipped"
  | "waiting_approval"

/**
 * Deterministic predicate over settled upstream results. `node` must be a
 * dependency. `field` is a dotted path into the upstream payload; omit it to
 * test the whole payload. A skipped or failed upstream resolves to null.
 */
export type DagCondition =
  | {
      readonly node: string
      readonly field?: string
      readonly equals?: JsonValue
      readonly includes?: string
      readonly matches?: string
      readonly exists?: boolean
    }
  | { readonly all: readonly DagCondition[] }
  | { readonly any: readonly DagCondition[] }
  | { readonly not: DagCondition }

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
    readonly status: DagResultEnvelope["status"] | "skipped"
    readonly sessionID: string | null
  } | null
}

/**
 * `agent` is required for agent nodes; `model` is optional and, when omitted,
 * is filled at create/amend time from the Iolaus models config for that lane.
 * A `gate` node has no execution target: `prompt` is the message shown to the
 * human, and the node waits in `waiting_approval` until approved or rejected.
 */
export interface DagNodeDefinition {
  readonly id: string
  /** One-line summary of what the node does, shown next to its id in the TUI. Not part of the fingerprint. */
  readonly title?: string
  readonly kind?: DagNodeKind
  readonly agent?: string
  readonly model?: string
  readonly prompt: string
  readonly dependsOn: readonly string[]
  readonly inputs?: readonly DagInputBinding[]
  readonly when?: DagCondition
  readonly maxAttempts?: number
  /**
   * Models tried in order when a child fails on its model (provider error, failed
   * session, empty reply). Filled from the lane's iolaus.json chain when `model` is
   * omitted. Not part of the fingerprint: a fallback changes the model a node runs
   * on, not what the node is.
   */
  readonly fallbackModels?: readonly string[]
  /**
   * Run the child in its own git worktree on a fresh branch
   * (`iolaus/<run>-<node>`) cut from the run directory's HEAD. Agent nodes only.
   */
  readonly worktree?: boolean
}

/**
 * A review loop the scheduler grows on demand: when `review` settles with FAIL,
 * a new `fix<n>` (executor) and `review<n>` (reviewer) pair is appended via
 * amend, up to `maxRounds`. Nodes are never rewritten, so completed work is
 * reused and the graph stays a DAG.
 */
export interface DagLoop {
  readonly review: string
  readonly fix: string
  readonly executorPrompt: string
  readonly reviewerPrompt: string
  readonly failIncludes: string
  readonly passIncludes: string
  readonly maxRounds: number
  /** Nodes that wait on the latest review (e.g. the accept gate); their dependsOn/when are rewritten to the newest review. */
  readonly tail?: readonly string[]
}

export interface DagDefinition {
  readonly schemaVersion: 1
  readonly name: string
  /**
   * An observed run records native subagent calls instead of scheduling them:
   * nodes are ordered by time and nested by parent, have no data-dependency
   * edges, and cannot be retried, resumed or amended.
   */
  readonly observed?: true
  readonly loop?: DagLoop
  readonly nodes: readonly DagNodeDefinition[]
  readonly maxParallel?: number
  /**
   * Absolute directory the run's child sessions work in, e.g. the git worktree
   * /start-work --worktree created. Must be a worktree of the project's own
   * repository; omitted, children work in the project directory.
   */
  readonly directory?: string
}

/** A native subagent call as it starts: the child session and where it hangs in its owner's observed run. */
export interface DagObservedStart {
  readonly ownerSessionID: string
  /** Absent when the call failed before a child session existed. */
  readonly sessionID?: string
  readonly agent: string
  /** Known once the child session exists; set later through a running update. */
  readonly model?: string
  readonly title: string
  readonly prompt: string
  readonly parentNodeID?: string
}

export type DagObservedUpdate =
  /** A follow-up to the node, or the child session and model becoming known. */
  | { readonly status: "running"; readonly sessionID?: string; readonly model?: string }
  | { readonly status: "completed"; readonly text: string; readonly model?: string }
  | { readonly status: "failed" | "interrupted"; readonly error: string }

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
  readonly authorizedPlan?: string
  readonly authorizedAtlasNodes?: Readonly<Record<string, string>>
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
    | "node.skipped"
    | "node.waiting"
    | "node.approved"
    | "node.rejected"
    | "loop.grown"
    | "node.fallback"
    | "node.escalated"
    | "run.paused"
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
