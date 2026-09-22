import { isRecord } from "@oh-my-opencode/utils"

export const BTW_METADATA_KEY = "omo_btw"
export const BTW_METADATA_VERSION = 1

export type BtwMetadata = {
  version: typeof BTW_METADATA_VERSION
  parent_session_id: string
}

export function createBtwMetadata(parentSessionID: string): BtwMetadata {
  return {
    version: BTW_METADATA_VERSION,
    parent_session_id: parentSessionID,
  }
}

export function parseBtwMetadata(value: unknown): BtwMetadata | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== BTW_METADATA_VERSION) return undefined
  if (typeof value.parent_session_id !== "string" || value.parent_session_id.length === 0) {
    return undefined
  }
  return {
    version: BTW_METADATA_VERSION,
    parent_session_id: value.parent_session_id,
  }
}

/** Reads BTW metadata off a prompt-input metadata record. */
export function getBtwMetadata(metadata: Record<string, unknown> | undefined): BtwMetadata | undefined {
  if (metadata === undefined) return undefined
  return parseBtwMetadata(metadata[BTW_METADATA_KEY])
}
