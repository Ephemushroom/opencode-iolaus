import { expect, test } from "bun:test"

import { buildContinuationPrompt } from "./index"
import type { Goal } from "./index"

test("#given markup in an objective #when continuation is built #then untrusted text is XML escaped", () => {
  // given
  const goal: Goal = {
    id: "g1",
    sessionID: "s1",
    objective: "Ship <script> & verify",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  }

  // when
  const prompt = buildContinuationPrompt(goal)

  // then
  expect(prompt).toContain("<untrusted_objective>")
  expect(prompt).toContain("Ship &lt;script&gt; &amp; verify")
  expect(prompt).not.toContain("Ship <script> & verify")
})
