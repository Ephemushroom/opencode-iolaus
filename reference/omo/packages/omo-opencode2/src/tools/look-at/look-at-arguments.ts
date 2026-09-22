export interface LookAtArgs {
  filePaths: string[]
  goal: string
}

export type LookAtArgsResult = { ok: true; args: LookAtArgs } | { ok: false; error: string }

const REMOTE_PREFIXES = ["http://", "https://"]

function readStringList(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/**
 * Parse `look_at` input into a validated shape.
 *
 * Mirrors v1's contract for the file-path surface: a `path` alias, singular
 * values promoted to a list, a required goal, and remote URLs rejected. v1's
 * base64 `image_data` surface is deliberately not ported; without attachment
 * parts it would need temp-file lifecycle and mime inference for an affordance
 * v2's native `read` already covers for local files.
 */
export function parseLookAtArgs(raw: unknown): LookAtArgsResult {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>

  const filePaths = [
    ...readStringList(input.file_path),
    ...readStringList(input.file_paths),
    ...readStringList(input.path),
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (filePaths.length === 0) {
    return { ok: false, error: "file_path (or file_paths) is required and must be a non-empty path." }
  }

  const remote = filePaths.find((entry) =>
    REMOTE_PREFIXES.some((prefix) => entry.toLowerCase().startsWith(prefix)),
  )
  if (remote) {
    return { ok: false, error: `Remote URLs are not supported: ${remote}. Provide a local file path.` }
  }

  const goal = typeof input.goal === "string" ? input.goal.trim() : ""
  if (goal.length === 0) {
    return { ok: false, error: "goal is required: state what to extract from the file." }
  }

  return { ok: true, args: { filePaths, goal } }
}
