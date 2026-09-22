import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { isWithinProject, log } from "@oh-my-opencode/utils"

// Resolved lazily (not captured at module-eval time): os.homedir() is stable at
// runtime, but freezing these at import time races the home directory against
// any importer that mutates HOME/USERPROFILE after this module is first evaluated
// (e.g. the test harness's hermetic-HOME preload). Compute on each call so the
// allow-list always matches the tilde expansion below.
function allowedHomeSubdirs(): readonly string[] {
  return [
    join(homedir(), ".config", "opencode"),
    join(homedir(), ".config", "oh-my-openagent"),
    join(homedir(), ".omo"),
    join(homedir(), ".opencode"),
  ]
}

function isWithinAllowedPaths(filePath: string, projectRoot: string): boolean {
  if (isWithinProject(filePath, projectRoot)) return true
  for (const dir of allowedHomeSubdirs()) {
    if (isWithinProject(filePath, dir)) return true
  }
  return false
}

export function resolvePromptAppend(promptAppend: string, configDir?: string): string {
  if (!promptAppend.startsWith("file://")) return promptAppend

  const encoded = promptAppend.slice(7)

  let filePath: string
  try {
    const decoded = decodeURIComponent(encoded)
    const expanded = decoded.startsWith("~/") ? decoded.replace(/^~\//, `${homedir()}/`) : decoded
    filePath = isAbsolute(expanded)
      ? expanded
      : resolve(configDir ?? process.cwd(), expanded)
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return `[WARNING: Malformed file URI (invalid percent-encoding): ${promptAppend}]`
  }

  const projectRoot = configDir ?? process.cwd()
  if (!isWithinAllowedPaths(filePath, projectRoot)) {
    log("[resolve-file-uri] Rejected file URI outside allowed paths", {
      promptAppend,
      filePath,
      projectRoot,
      allowedHomeSubdirs: allowedHomeSubdirs(),
    })
    return `[WARNING: Path rejected: ${promptAppend} (resolved outside project root ${projectRoot} and allowed home directories; file:// prompts must reside within the project directory, ~/.config/opencode/, ~/.config/oh-my-openagent/, ~/.omo/, or ~/.opencode/)]`
  }

  if (!existsSync(filePath)) {
    return `[WARNING: Could not resolve file URI: ${promptAppend}]`
  }

  try {
    return readFileSync(filePath, "utf8")
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return `[WARNING: Could not read file: ${promptAppend}]`
  }
}
