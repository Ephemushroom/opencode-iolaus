import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import {
  isRecord,
  resolveCommentCheckerBinary,
  runCommentChecker,
  type SpawnProcess,
} from "@oh-my-opencode/comment-checker-core"

import type { CommentCheckerRuntime } from "./register"

const COMMENT_CHECKER_PACKAGE = "@code-yeongyu/comment-checker"

export function createDefaultCommentCheckerRuntime(): CommentCheckerRuntime {
  return {
    resolveBinary: resolveOptionalBinary,
    run: async (input) =>
      runCommentChecker(input, {
        existsSync,
        spawn: spawnCommentChecker,
      }),
  }
}

export function resolveOptionalBinary(): string | null {
  const packageBinary = resolvePackageApiBinary()
  if (packageBinary !== null) {
    return packageBinary
  }

  return resolveCommentCheckerBinary({
    binaryName: process.platform === "win32" ? "comment-checker.exe" : "comment-checker",
    cachedBinaryPath: null,
    existsSync,
    importMetaUrl: import.meta.url,
  })
}

function resolvePackageApiBinary(): string | null {
  try {
    const requireModule = createRequire(import.meta.url)
    const packageExports: unknown = requireModule(COMMENT_CHECKER_PACKAGE)
    if (!isRecord(packageExports)) return null

    const getBinaryPath = packageExports["getBinaryPath"]
    if (typeof getBinaryPath !== "function") return null

    const binaryPath: unknown = getBinaryPath()
    return typeof binaryPath === "string" && existsSync(binaryPath) ? binaryPath : null
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

function spawnCommentChecker(args: readonly string[]): SpawnProcess {
  const subprocess = Bun.spawn([...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    stdin: {
      write(input: string): void {
        subprocess.stdin.write(input)
      },
      end(): void {
        subprocess.stdin.end()
      },
    },
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited,
    kill(signal): void {
      subprocess.kill(signal)
    },
  }
}
