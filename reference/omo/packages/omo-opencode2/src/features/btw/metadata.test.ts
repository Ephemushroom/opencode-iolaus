import { describe, expect, test } from "bun:test"

import {
  BTW_METADATA_KEY,
  createBtwMetadata,
  getBtwMetadata,
  parseBtwMetadata,
} from "./metadata"

describe("btw metadata", () => {
  test("create + parse roundtrip", () => {
    const metadata = createBtwMetadata("ses_parent")
    expect(parseBtwMetadata(metadata)).toEqual(metadata)
  })

  test("rejects malformed values", () => {
    expect(parseBtwMetadata(undefined)).toBeUndefined()
    expect(parseBtwMetadata(null)).toBeUndefined()
    expect(parseBtwMetadata("btw")).toBeUndefined()
    expect(parseBtwMetadata({})).toBeUndefined()
    expect(parseBtwMetadata({ version: 2, parent_session_id: "ses_x" })).toBeUndefined()
    expect(parseBtwMetadata({ version: 1, parent_session_id: "" })).toBeUndefined()
    expect(parseBtwMetadata({ version: 1 })).toBeUndefined()
  })

  test("getBtwMetadata reads the key off a metadata record", () => {
    const metadata = createBtwMetadata("ses_parent")
    expect(getBtwMetadata({ [BTW_METADATA_KEY]: metadata })).toEqual(metadata)
    expect(getBtwMetadata({})).toBeUndefined()
    expect(getBtwMetadata(undefined)).toBeUndefined()
  })
})
