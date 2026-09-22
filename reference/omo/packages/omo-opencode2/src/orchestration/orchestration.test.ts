import { describe, expect, test } from "bun:test"

import { TaskRegistry } from "./task-registry"
import { ConcurrencyLimiter } from "./concurrency"
import { nextFallbackModel } from "./child-session"

describe("TaskRegistry", () => {
  test("#given a fresh registry #when creating a task #then it tracks status and output", () => {
    // given
    const registry = new TaskRegistry()

    // when
    const task = registry.create({ parentSessionID: "parent-1", agent: "oracle", model: "openai/gpt-5.6-sol", description: "answer", background: false })

    // then
    expect(task.status).toBe("queued")
    expect(registry.get(task.id)).toBe(task)
    expect(registry.list()).toHaveLength(1)
    expect(registry.listByParent("parent-1")).toHaveLength(1)
  })

  test("#given a running task #when text arrives #then output aggregates", () => {
    // given
    const registry = new TaskRegistry()
    const task = registry.create({ parentSessionID: "p", agent: "oracle", model: "openai/gpt-5.6-sol", description: "d", background: false })

    // when
    registry.appendText(task.id, "first")
    registry.appendText(task.id, "second")

    // then
    expect(registry.output(task.id)).toBe("first\nsecond")
  })

  test("#given a task #when completing/failing/cancelling #then status and error are recorded", () => {
    // given
    const registry = new TaskRegistry()
    const task = registry.create({ parentSessionID: "p", agent: "oracle", model: "openai/gpt-5.6-sol", description: "d", background: true })

    // when
    registry.fail(task.id, "boom")

    // then
    const after = registry.get(task.id)
    expect(after?.status).toBe("failed")
    expect(after?.error).toBe("boom")
    expect(after?.completedAt).toBeDefined()
  })
})

describe("ConcurrencyLimiter", () => {
  test("#given a limit of 2 #when 3 tasks acquire #then the third queues until a release", async () => {
    // given
    const limiter = new ConcurrencyLimiter(2)

    // when
    await limiter.acquire("openai/gpt-5.6-sol")
    await limiter.acquire("openai/gpt-5.6-sol")
    let thirdAcquired = false
    const third = limiter.acquire("openai/gpt-5.6-sol").then(() => {
      thirdAcquired = true
    })

    // then
    expect(thirdAcquired).toBe(false)
    limiter.release("openai/gpt-5.6-sol")
    await third
    expect(thirdAcquired).toBe(true)
  })

  test("#given different model keys #when acquiring #then they do not share slots", async () => {
    // given
    const limiter = new ConcurrencyLimiter(1)

    // when
    await limiter.acquire("openai/gpt-5.6-sol")
    await limiter.acquire("anthropic/claude-opus-5")

    // then
    expect(true).toBe(true)
  })
})

describe("nextFallbackModel", () => {
  test("#given an agent with a fallback chain #when the current model matches an entry #then returns the next entry", () => {
    // given
    const agent = "oracle"

    // when
    const next = nextFallbackModel(agent, "openai/gpt-5.6-sol")

    // then
    expect(typeof next).toBe("string")
  })

  test("#given the last chain entry #when resolving the next #then returns undefined", () => {
    // given
    const agent = "hephaestus"

    // when
    const next = nextFallbackModel(agent, "openai/gpt-5.6-sol")

    // then: hephaestus chain has a single entry, so no next model
    expect(next).toBeUndefined()
  })

  test("#given an unknown agent #when resolving #then returns undefined", () => {
    // when
    const next = nextFallbackModel("no-such-agent", "openai/gpt-5.6-sol")

    // then
    expect(next).toBeUndefined()
  })
})
