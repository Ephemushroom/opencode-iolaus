import { expect, test } from "bun:test"

import { isBuiltinMcpName } from "./types"

test("#given a user-owned CodeGraph server name #when classifying it #then it is not a built-in", () => {
  // given
  const name = "codegraph"

  // when
  const builtin = isBuiltinMcpName(name)

  // then
  expect(builtin).toBe(false)
})
