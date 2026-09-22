import { expect, test } from "bun:test"
import { Admission } from "./admission"

test("#given saturated Team capacity #when another model request is admitted #then blocked Team work holds no model permit", () => {
  const admission = new Admission({ model: 2, team: 1 })
  const first = { key: "first", model: "p/m", session: "a", team: "t" }
  admission.enqueue(first)
  expect(admission.take()).toEqual([first])
  admission.enqueue({ key: "blocked", model: "p/m", session: "b", team: "t" })
  const ordinary = { key: "ordinary", model: "p/m", session: "c" }
  admission.enqueue(ordinary)
  expect(admission.take()).toEqual([ordinary])
})

test("#given queued work #when cancelled before capacity opens #then it is never admitted", () => {
  const admission = new Admission({ model: 1, team: 1 })
  const first = { key: "first", model: "p/m", session: "a" }
  admission.enqueue(first)
  admission.take()
  admission.enqueue({ key: "cancelled", model: "p/m", session: "b" })
  admission.remove("cancelled")
  admission.release("first")
  expect(admission.take()).toEqual([])
})

test("#given a busy retained session #when another model turn is queued #then session admission remains serialized", () => {
  const admission = new Admission({ model: 5, team: 4 })
  admission.enqueue({ key: "first", model: "p/m", session: "a" })
  admission.take()
  const next = { key: "next", model: "p/other", session: "a" }
  admission.enqueue(next)
  expect(admission.take()).toEqual([])
  admission.release("first")
  expect(admission.take()).toEqual([next])
})

test("#given eligible queued work #when nested immediate admission is requested #then queued work is not overtaken", () => {
  const admission = new Admission({ model: 1, team: 1 })
  admission.enqueue({ key: "queued", model: "p/m", session: "a" })
  expect(admission.immediate({ key: "nested", model: "p/m", session: "b" })).toBe(false)
})
