import { describe, expect, test } from "bun:test"

import { TodoStore } from "./store"
import type { TodoItem } from "./types"

const sampleItems: TodoItem[] = [
  { id: "a", content: "first task", status: "in_progress", priority: "high" },
  { id: "b", content: "second task", status: "pending", priority: "medium" },
]

describe("TodoStore", () => {
  test("#given empty store #when get #then returns empty array", () => {
    // given
    const store = new TodoStore()

    // when
    const result = store.get("s1")

    // then
    expect(result).toEqual([])
  })

  test("#given items set #when get #then returns them", () => {
    // given
    const store = new TodoStore()

    // when
    store.set("s1", sampleItems)
    const result = store.get("s1")

    // then
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe("a")
    expect(result[1]?.content).toBe("second task")
  })

  test("#given items set #when set with empty array #then clears the session", () => {
    // given
    const store = new TodoStore()
    store.set("s1", sampleItems)

    // when
    store.set("s1", [])

    // then
    expect(store.get("s1")).toEqual([])
  })

  test("#given two sessions #when set on one #then the other is unaffected", () => {
    // given
    const store = new TodoStore()

    // when
    store.set("s1", sampleItems)

    // then
    expect(store.get("s1")).toHaveLength(2)
    expect(store.get("s2")).toEqual([])
  })

  test("#given items set #when clear #then session is removed", () => {
    // given
    const store = new TodoStore()
    store.set("s1", sampleItems)

    // when
    store.clear("s1")

    // then
    expect(store.get("s1")).toEqual([])
  })
})
