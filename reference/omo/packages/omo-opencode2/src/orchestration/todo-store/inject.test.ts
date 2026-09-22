import { describe, expect, test } from "bun:test"

import { injectTodoStateSystemPart } from "./inject"
import { TodoStore } from "./store"
import { createTodoWriteTool } from "./tool"

const baseSystem = [{ type: "text", text: "existing context" }]

describe("injectTodoStateSystemPart", () => {
  test("#given empty items #when inject #then system is unchanged", () => {
    // given

    // when
    const result = injectTodoStateSystemPart(baseSystem, [])

    // then
    expect(result).toEqual(baseSystem)
  })

  test("#given items #when inject #then appends a todo-state part", () => {
    // given
    const items = [
      { id: "t1", content: "Build the thing", status: "in_progress" as const, priority: "high" as const },
      { id: "t2", content: "Test the thing", status: "pending" as const, priority: "medium" as const },
    ]

    // when
    const result = injectTodoStateSystemPart(baseSystem, items)

    // then
    const todoParts = result.filter((part) => part.text?.includes("<todo-state>"))
    expect(todoParts).toHaveLength(1)
    expect(todoParts[0]?.text).toContain("Build the thing")
    expect(todoParts[0]?.text).toContain("Test the thing")
    expect(todoParts[0]?.text).toContain("2 active")
    expect(result[0]?.text).toBe("existing context")
  })

  test("#given prior todo-state #when inject #then replaces it", () => {
    // given
    const withOld = [
      { type: "text", text: "base" },
      { type: "text", text: "<todo-state>\nold stuff\n</todo-state>" },
    ]
    const items = [
      { id: "t1", content: "New item", status: "pending" as const, priority: "low" as const },
    ]

    // when
    const result = injectTodoStateSystemPart(withOld, items)

    // then
    const todoParts = result.filter((part) => part.text?.includes("<todo-state>"))
    expect(todoParts).toHaveLength(1)
    expect(todoParts[0]?.text).toContain("New item")
    expect(todoParts[0]?.text).not.toContain("old stuff")
  })

  test("#given all completed #when inject #then shows zero active", () => {
    // given
    const items = [
      { id: "t1", content: "Done", status: "completed" as const, priority: "high" as const },
    ]

    // when
    const result = injectTodoStateSystemPart(baseSystem, items)

    // then
    const todoParts = result.filter((part) => part.text?.includes("<todo-state>"))
    expect(todoParts[0]?.text).toContain("0 active")
    expect(todoParts[0]?.text).toContain("1 completed")
  })
})

describe("todo compaction survival", () => {
  test("#given todos written #when messages cleared then composer runs #then todo state is still present", async () => {
    // given
    const store = new TodoStore()
    const tool = createTodoWriteTool({ store })
    await tool.execute(
      [
        { id: "survive", content: "Must survive compaction", status: "in_progress", priority: "high" },
      ],
      { sessionID: "s1" },
    )

    // when: simulate compaction by building a fresh system array with no
    // todo-state part, then running injection again from the store
    const afterCompaction: Array<{ type: string; text: string }> = [
      { type: "text", text: "post-compaction system prompt" },
    ]
    const result = injectTodoStateSystemPart(afterCompaction, store.get("s1"))

    // then
    const todoParts = result.filter((part) => part.text?.includes("<todo-state>"))
    expect(todoParts).toHaveLength(1)
    expect(todoParts[0]?.text).toContain("Must survive compaction")
  })
})
