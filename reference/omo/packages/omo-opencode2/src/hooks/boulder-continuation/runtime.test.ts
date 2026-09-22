import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBoulderState, writeBoulderState } from "@oh-my-opencode/boulder-state"
import { describe, expect, test } from "bun:test"

import { createSessionDispatchGate } from "../../orchestration/session-dispatch-gate"
import { createBoulderContinuationRuntime } from "./runtime"
import { readBoulderContinuationState } from "./state"

const SESSION = "ses_test"
const idleEvent = { type: "session.idle", data: { sessionID: SESSION } }

const PLAN = [
  "# Plan",
  "",
  "## TODOs",
  "- [ ] 1. first task",
  "- [ ] 2. second task",
  "- [x] 3. done task",
  "",
].join("\n")

function fixture(options: { planText?: string; withBoulder?: boolean } = {}) {
  const { planText = PLAN, withBoulder = true } = options
  const dir = mkdtempSync(join(tmpdir(), "omo-boulder-test-"))
  mkdirSync(join(dir, ".omo", "plans"), { recursive: true })
  const planPath = join(dir, ".omo", "plans", "plan.md")
  writeFileSync(planPath, planText)
  if (withBoulder) {
    writeBoulderState(dir, createBoulderState(planPath, SESSION))
  }
  return { dir, planPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function harness(directory: string) {
  const prompts: string[] = []
  const runtime = createBoulderContinuationRuntime({
    directory,
    sessionExists: async () => true,
    dispatchContinuation: async (_sessionID, prompt) => {
      prompts.push(prompt)
    },
    settle: async () => undefined,
    gate: createSessionDispatchGate({ postDispatchHoldMs: 1 }),
  })
  return { prompts, runtime }
}

describe("boulder continuation state", () => {
  test("#given a session with an incomplete plan #when state is read #then the remaining checklist is reported", () => {
    // given
    const { dir, cleanup } = fixture()
    try {
      // when
      const state = readBoulderContinuationState(dir, SESSION)

      // then
      expect(state).not.toBeNull()
      expect(state?.checklist.total).toBe(3)
      expect(state?.checklist.completed).toBe(1)
      expect(state?.checklist.remaining).toBe(2)
    } finally {
      cleanup()
    }
  })

  test("#given a single active work and a session not recorded in it #when state is read #then it is still the session's plan (sole-active)", () => {
    // given
    const { dir, cleanup } = fixture()
    try {
      // when
      const state = readBoulderContinuationState(dir, "ses_someone_else")

      // then
      expect(state).not.toBeNull()
      expect(state?.boundVia).toBe("sole-active")
    } finally {
      cleanup()
    }
  })

  test("#given no boulder file at all #when state is read #then it is null", () => {
    // given
    const { dir, cleanup } = fixture({ withBoulder: false })
    try {
      // when
      const state = readBoulderContinuationState(dir, SESSION)

      // then
      expect(state).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("#given a fully checked plan #when state is read #then it is null so no idle prompt fires", () => {
    // given
    const allDone = ["# Plan", "", "## TODOs", "- [x] 1. first task", "- [x] 2. second task", ""].join("\n")
    const { dir, cleanup } = fixture({ planText: allDone })
    try {
      // when
      const state = readBoulderContinuationState(dir, SESSION)

      // then
      expect(state).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe("boulder continuation runtime", () => {
  test("#given an unfinished plan #when the session goes idle #then the continuation lists the next task", async () => {
    // given
    const { dir, cleanup } = fixture()
    try {
      const { prompts, runtime } = harness(dir)

      // when
      await runtime.handleEvent(idleEvent)

      // then
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("unfinished work")
      expect(prompts[0]).toContain("1/3")
      expect(prompts[0]).toContain("first task")
    } finally {
      cleanup()
    }
  })

  test("#given no continuable state #when the session goes idle #then nothing is injected", async () => {
    // given
    const { dir, cleanup } = fixture({ withBoulder: false })
    try {
      const { prompts, runtime } = harness(dir)

      // when
      await runtime.handleEvent(idleEvent)

      // then
      expect(prompts).toEqual([])
    } finally {
      cleanup()
    }
  })
})
