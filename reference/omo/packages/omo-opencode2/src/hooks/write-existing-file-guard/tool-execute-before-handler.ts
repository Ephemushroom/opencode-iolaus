import type { Context } from "@opencode/plugin/effect/plugin"
import { existsSync } from "node:fs"
import {
  asRecord,
  getPathFromArgs,
  isOverwriteEnabled,
  isPathInsideDirectory,
  resolveInputPath,
  toCanonicalPath,
  type GuardArgs,
} from "./hook"
import {
  evictLeastRecentlyUsedSession,
  touchSession,
  trimSessionReadSet,
} from "./session-read-permissions"

type Trace = (event: string, detail?: Record<string, unknown>) => void

function ensureSessionReadSet(params: {
  sessionID: string
  readPermissionsBySession: Map<string, Set<string>>
  sessionLastAccess: Map<string, number>
  maxTrackedSessions: number
}): Set<string> {
  const { sessionID, readPermissionsBySession, sessionLastAccess, maxTrackedSessions } = params
  let readSet = readPermissionsBySession.get(sessionID)
  if (!readSet) {
    if (readPermissionsBySession.size >= maxTrackedSessions) {
      evictLeastRecentlyUsedSession(readPermissionsBySession, sessionLastAccess)
    }

    readSet = new Set<string>()
    readPermissionsBySession.set(sessionID, readSet)
  }

  touchSession(sessionLastAccess, sessionID)
  return readSet
}

function registerReadPermission(params: {
  sessionID: string
  canonicalPath: string
  readPermissionsBySession: Map<string, Set<string>>
  sessionLastAccess: Map<string, number>
  maxTrackedSessions: number
  maxTrackedPathsPerSession: number
}): void {
  const readSet = ensureSessionReadSet(params)
  if (readSet.has(params.canonicalPath)) {
    readSet.delete(params.canonicalPath)
  }

  readSet.add(params.canonicalPath)
  trimSessionReadSet(readSet, params.maxTrackedPathsPerSession)
}

function consumeReadPermission(params: {
  sessionID: string
  canonicalPath: string
  readPermissionsBySession: Map<string, Set<string>>
  sessionLastAccess: Map<string, number>
}): boolean {
  const readSet = params.readPermissionsBySession.get(params.sessionID)
  if (!readSet || !readSet.has(params.canonicalPath)) {
    return false
  }

  readSet.delete(params.canonicalPath)
  touchSession(params.sessionLastAccess, params.sessionID)
  return true
}

function invalidateOtherSessions(
  readPermissionsBySession: Map<string, Set<string>>,
  canonicalPath: string,
  writingSessionID?: string,
): void {
  for (const [sessionID, readSet] of readPermissionsBySession.entries()) {
    if (writingSessionID && sessionID === writingSessionID) {
      continue
    }

    readSet.delete(canonicalPath)
  }
}

export function isOmoWorkspacePath(canonicalPath: string): boolean {
  return /(^|[/\\])\.omo([/\\]|$)/.test(canonicalPath)
}

export async function handleWriteExistingFileGuardToolExecuteBefore(params: {
  ctx: Context
  event: Parameters<Context["tool"]["hook"]>[1] extends (event: infer T) => unknown ? T : never
  readPermissionsBySession: Map<string, Set<string>>
  sessionLastAccess: Map<string, number>
  getCanonicalSessionRoot: () => string
  maxTrackedSessions: number
  maxTrackedPathsPerSession: number
  trace?: Trace
  directory: string
}): Promise<void> {
  const {
    ctx,
    event,
    readPermissionsBySession,
    sessionLastAccess,
    getCanonicalSessionRoot,
    maxTrackedSessions,
    maxTrackedPathsPerSession,
    trace,
    directory,
  } = params
  
  const toolName = event.tool?.toLowerCase()
  if (toolName !== "write" && toolName !== "read") {
    return
  }

  const argsRecord = asRecord(event.input)
  const args = argsRecord as GuardArgs | undefined
  const filePath = getPathFromArgs(args)
  if (!filePath) {
    return
  }

  const resolvedPath = resolveInputPath(directory, filePath)
  const canonicalSessionRoot = getCanonicalSessionRoot()
  const canonicalPath = toCanonicalPath(resolvedPath)
  
  if (!isPathInsideDirectory(canonicalPath, canonicalSessionRoot)) {
    return
  }

  if (toolName === "read") {
    if (!existsSync(resolvedPath) || !event.sessionID) {
      return
    }

    registerReadPermission({
      sessionID: event.sessionID,
      canonicalPath,
      readPermissionsBySession,
      sessionLastAccess,
      maxTrackedSessions,
      maxTrackedPathsPerSession,
    })
    return
  }

  const overwriteEnabled = isOverwriteEnabled(args?.overwrite)
  if (argsRecord && "overwrite" in argsRecord) {
    delete argsRecord.overwrite
  }

  if (!existsSync(resolvedPath)) {
    return
  }

  if (isOmoWorkspacePath(canonicalPath)) {
    trace?.("omo.write-existing-file-guard.allow", {
      reason: ".omo overwrite",
      sessionID: event.sessionID,
      filePath,
    })
    invalidateOtherSessions(readPermissionsBySession, canonicalPath, event.sessionID)
    return
  }

  if (overwriteEnabled) {
    trace?.("omo.write-existing-file-guard.allow", {
      reason: "overwrite flag",
      sessionID: event.sessionID,
      filePath,
      resolvedPath,
    })
    invalidateOtherSessions(readPermissionsBySession, canonicalPath, event.sessionID)
    return
  }

  if (event.sessionID && consumeReadPermission({ sessionID: event.sessionID, canonicalPath, readPermissionsBySession, sessionLastAccess })) {
    trace?.("omo.write-existing-file-guard.allow", {
      reason: "after read",
      sessionID: event.sessionID,
      filePath,
      resolvedPath,
    })
    invalidateOtherSessions(readPermissionsBySession, canonicalPath, event.sessionID)
    return
  }

  trace?.("omo.write-existing-file-guard.block", {
    sessionID: event.sessionID,
    filePath,
    resolvedPath,
  })

  throw new Error("File already exists. Use edit tool instead.")
}
