import { describe, expect, test } from "bun:test"

import { TodoStore } from "./store"
import { createTodoWriteTool } from "./tool"

function createTool(store = new TodoStore()) {
  return createTodoWriteTool({ store })
}

const validInput = {
  todos: [
    { id: "step-1", content: "Do the first thing", status: "in_progress", priority: "high" },
    { id: "step-2", content: "Do the second thing", status: "pending", priority: "medium" },
  ],
}

describe("createTodoWriteTool", () => {
  test("#given valid input #when execute #then stores items and returns count", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)

    // when
    const result = await tool.execute(validInput, { sessionID: "s1" })

    // then
    expect(result.content).toContain("2 items")
    expect(result.content).toContain("2 active")
    expect(store.get("s1")).toHaveLength(2)
  })

  test("#given completed items #when execute #then active count excludes them", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)
    const input = {
      todos: [
        { id: "done", content: "Already done", status: "completed", priority: "low" },
        { id: "active", content: "Still going", status: "in_progress", priority: "high" },
      ],
    }

    // when
    const result = await tool.execute(input, { sessionID: "s1" })

    // then
    expect(result.content).toContain("2 items")
    expect(result.content).toContain("1 active")
  })

  test("#given invalid input (not an object) #when execute #then returns error", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)

    // when
    const result = await tool.execute("not an object", { sessionID: "s1" })

    // then
    expect(result.content).toContain("Error")
    expect(store.get("s1")).toEqual([])
  })

  test("#given item missing required field #when execute #then returns error", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)
    const badInput = { todos: [{ id: "x", content: "missing status and priority" }] }

    // when
    const result = await tool.execute(badInput, { sessionID: "s1" })

    // then
    expect(result.content).toContain("Error")
    expect(store.get("s1")).toEqual([])
  })

  test("#given empty todos array #when execute #then clears the store", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)
    await tool.execute(validInput, { sessionID: "s1" })

    // when
    const result = await tool.execute({ todos: [] }, { sessionID: "s1" })

    // then
    expect(result.content).toContain("0 items")
    expect(store.get("s1")).toEqual([])
  })

  test("#given todos as JSON string #when execute #then parses and stores", async () => {
    // given
    const store = new TodoStore()
    const tool = createTool(store)
    const input = {
      todos: JSON.stringify([
        { id: "s1", content: "String-encoded item", status: "pending", priority: "low" },
      ]),
    }

    // when
    const result = await tool.execute(input, { sessionID: "s1" })

    // then
    expect(result.content).toContain("1 item")
    expect(store.get("s1")).toHaveLength(1)
    expect(store.get("s1")[0]?.content).toBe("String-encoded item")
  })
})
