import { randomUUID } from "node:crypto"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Clock, Deferred, Effect, Queue, Semaphore } from "effect"
import { ExecutionError } from "./errors"
import { readRecord, saveRecord } from "./records"
import type { ExecutionRuntime } from "./runtime"
import { isTerminal, ownerKey, runKey, TaskID, type SubmitRequest, type TerminalRecord } from "./types"

export const submit = Effect.fn("execution.submit")(function* (runtime: ExecutionRuntime, request: SubmitRequest) {
  return yield* Semaphore.withPermit(runtime.mutex)(Effect.uninterruptible(Effect.gen(function* () {
    if (runtime.closed || runtime.owners.has(ownerKey(request.owner))) {
      return yield* new ExecutionError({ code: "owner-closed", message: "Execution owner is closed" })
    }
    const previous = request.kind !== "fresh" ? yield* readRecord(runtime, request.previous) : undefined
    if (previous && ((request.kind === "continuation" && !isTerminal(previous)) || ownerKey(previous.owner) !== ownerKey(request.owner))) {
      return yield* new ExecutionError({ code: "conflict", message: "Continuation requires a settled execution owned by the caller" })
    }
    if (request.inputID && previous) {
      const accepted = [...runtime.records.values()].find((record) => record.inputID === request.inputID
        && record.sessionID === previous.sessionID && ownerKey(record.owner) === ownerKey(request.owner))
      if (accepted) return accepted.ref
    }
    const generation = previous ? Math.max(...[...runtime.records.values()]
      .filter((record) => record.ref.taskID === previous.ref.taskID).map((record) => record.ref.generation)) + 1 : 1
    const ref = previous
      ? { taskID: previous.ref.taskID, generation: request.kind === "message" ? generation : previous.ref.generation + 1 }
      : { taskID: TaskID.make(`task_${randomUUID()}`), generation: 1 }
    if (runtime.records.has(runKey(ref))) {
      return yield* new ExecutionError({ code: "conflict", message: "Continuation generation already exists" })
    }
    const sessionID = previous?.sessionID ?? (request.kind === "fresh" ? request.sessionID : undefined) ?? Session.ID.create()
    if (!previous && [...runtime.records.values()].some((record) => record.sessionID === sessionID)) {
      return yield* new ExecutionError({ code: "conflict", message: "Session is already managed by an execution" })
    }
    const agent = request.kind === "fresh" ? request.agent : previous?.agent
    const model = request.model ?? previous?.model
    if (!agent || !model) return yield* new ExecutionError({ code: "conflict", message: "Execution routing is missing" })
    const permit = { key: runKey(ref), model: `${model.providerID}/${model.id}`, session: sessionID,
      ...(request.owner.kind === "team" ? { team: request.owner.teamRunID } : {}) }
    if (request.immediate && !runtime.admission.immediate(permit)) {
      return yield* new ExecutionError({ code: "capacity", message: "Nested blocking work requires immediate capacity; submit background work instead" })
    }
    const record = {
      version: 1 as const, ref, owner: request.owner, writer: runtime.writer, sessionID,
      inputID: request.inputID ?? SessionMessage.ID.create(), agent, model, description: request.description,
      status: "queued" as const, output: "", background: request.background, createdAt: yield* Clock.currentTimeMillis,
    }
    const entry = { record, request, done: yield* Deferred.make<TerminalRecord, ExecutionError>(), cancellation: yield* Deferred.make<void>() }
    yield* saveRecord(runtime, record)
    runtime.entries.set(runKey(ref), entry)
    if (request.immediate) {
      runtime.admission.release(permit.key)
    }
    runtime.admission.enqueue(permit)
    yield* Queue.offer(runtime.signal, undefined)
    return ref
  })))
})
