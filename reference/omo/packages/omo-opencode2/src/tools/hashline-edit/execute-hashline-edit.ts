import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  applyHashlineEditsWithReport,
  canonicalizeFileText,
  HashlineMismatchError,
  normalizeHashlineEdits,
  restoreFileText,
  type RawHashlineEdit,
} from "@oh-my-opencode/hashline-core"

export interface HashlineEditArgs {
  filePath: string
  edits: RawHashlineEdit[]
}

export interface HashlineEditResult {
  rejected: boolean
  message: string
}

const REREAD_TIP =
  "Re-read the file to copy the current LINE#ID tags, then retry the edit."

function reject(message: string): HashlineEditResult {
  return { rejected: true, message }
}

/**
 * Applies hash-anchored edits to a file, FAIL-CLOSED.
 *
 * The supplied line hashes are validated against the current file content by
 * `@oh-my-opencode/hashline-core`. On ANY hash mismatch, missing file, empty
 * edit set, or apply error the file is left byte-identical and a rejection
 * message telling the model to re-read is returned. A write happens only after
 * validation succeeds and the content actually differs.
 */
export async function executeHashlineEdit(args: HashlineEditArgs): Promise<HashlineEditResult> {
  const { filePath, edits } = args

  if (!Array.isArray(edits) || edits.length === 0) {
    return reject(`No edits supplied for ${filePath}. ${REREAD_TIP}`)
  }

  if (!existsSync(filePath)) {
    return reject(`File not found: ${filePath}. ${REREAD_TIP}`)
  }

  let normalized
  try {
    normalized = normalizeHashlineEdits(edits)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reject(`Invalid edit: ${message}`)
  }

  let rawOldContent: string
  try {
    rawOldContent = readFileSync(filePath, "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reject(`Could not read ${filePath}: ${message}. ${REREAD_TIP}`)
  }

  const oldEnvelope = canonicalizeFileText(rawOldContent)

  let applyResult
  try {
    applyResult = applyHashlineEditsWithReport(oldEnvelope.content, normalized)
  } catch (error) {
    if (error instanceof HashlineMismatchError) {
      return reject(`Hash mismatch - a line changed since the last read. ${REREAD_TIP}\n\n${error.message}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    return reject(`Edit could not be applied to ${filePath}: ${message}. ${REREAD_TIP}`)
  }

  if (applyResult.content === oldEnvelope.content) {
    let diagnostic = `No changes made to ${filePath}. The edits produced identical content.`
    if (applyResult.noopEdits > 0) {
      diagnostic += ` No-op edits: ${applyResult.noopEdits}. ${REREAD_TIP}`
    }
    return reject(diagnostic)
  }

  const writeContent = restoreFileText(applyResult.content, oldEnvelope)
  try {
    writeFileSync(filePath, writeContent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reject(`Could not write ${filePath}: ${message}.`)
  }

  return { rejected: false, message: `Updated ${filePath}` }
}
