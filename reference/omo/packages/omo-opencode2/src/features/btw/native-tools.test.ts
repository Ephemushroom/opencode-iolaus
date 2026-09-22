import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { createNativeBtwTools } from "./native-tools"
import { TaskID, type Executor, type RunRef, type SubmitRequest, type TerminalRecord } from "../../orchestration/execution/types"

const parent = Session.ID.create()
const other = Session.ID.create()
const side = Session.ID.create()
const ref: RunRef = { taskID: TaskID.make("task"), generation: 1 }

function fixture(output = "answer"): { readonly tools: ReturnType<typeof createNativeBtwTools>; readonly cancelled: RunRef[]; readonly requests: SubmitRequest[] } {
  const cancelled: RunRef[] = []
  const requests: SubmitRequest[] = []
  const terminal: TerminalRecord = {
    version: 1, ref, owner: { kind: "btw", callerSessionID: parent, rootSessionID: parent }, writer: "test",
    sessionID: side, inputID: SessionMessage.ID.create(), agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"),
    description: "fixture", status: "completed", output, background: false, createdAt: 0,
  }
  const executor: Executor = {
    submit: (request) => Effect.sync(() => { requests.push(request); return ref }),
    snapshot: () => Effect.succeed(terminal),
    wait: () => Effect.succeed(terminal),
    cancel: (value) => Effect.sync(() => { cancelled.push(value) }),
    closeOwner: () => Effect.void,
    cancelMany: () => Effect.void,
    stopOwner: () => Effect.succeed(undefined), managed: () => Effect.succeed(undefined), list: () => Effect.succeed([]), latest: () => Effect.succeed(undefined),
  }
  const tools = createNativeBtwTools({ executor, cwd: ".", agent: Agent.ID.make("explore"), model: Model.Ref.parse("provider/model"), resolveSessionID: (ctx) => ctx === "other" ? other : parent })
  return { tools, cancelled, requests }
}

test("#given a BTW side session #when the owning caller lists it #then the public session id is returned", async () => {
  const fixtureValue = fixture()
  await Effect.runPromise(fixtureValue.tools.start({ question: "question" }, parent))
  const result = await Effect.runPromise(fixtureValue.tools.list(parent))
  expect(result.content).toContain(side)
  expect(result.content).not.toContain(ref.taskID)
})

test("#given a side session owned by another caller #when replying #then the reply is rejected", async () => {
  const fixtureValue = fixture()
  const started = await Effect.runPromise(fixtureValue.tools.start({ question: "question" }, parent))
  expect(started.content).toContain("answer")
  const result = await Effect.runPromise(fixtureValue.tools.reply({ side_session_id: side, text: "follow up" }, "other"))
  expect(result.content).toContain("owned by another session")
  expect(fixtureValue.requests).toHaveLength(1)
})

test("#given a completed side execution #when replying from its owner #then the executor receives a message request", async () => {
  const fixtureValue = fixture()
  await Effect.runPromise(fixtureValue.tools.start({ question: "question" }, parent))
  const result = await Effect.runPromise(fixtureValue.tools.reply({ side_session_id: side, text: "follow up" }, parent))
  expect(result.content).toContain("answer")
  expect(fixtureValue.requests[1]?.kind).toBe("message")
})
