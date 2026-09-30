import { execFileSync } from "node:child_process"
import { cpSync, existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { canonicalProject } from "../database"

/** Iolaus-made branches: `iolaus/<slug>`, no traversal, no leading dash. */
const BRANCH = /^iolaus\/[a-z0-9][a-z0-9._-]{0,80}$/

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    throw new Error(`git ${args[0]} failed: ${String(stderr || (error as Error).message).trim()}`)
  }
}

/** The main worktree's root, or undefined outside a git repository. */
export function repositoryRoot(directory: string): string | undefined {
  try {
    const common = canonicalProject(resolve(directory, git(directory, ["rev-parse", "--git-common-dir"])))
    return basename(common) === ".git" ? dirname(common) : git(directory, ["rev-parse", "--show-toplevel"])
  } catch {
    return undefined
  }
}

/** Whether `directory` is a worktree of the repository that contains `project`. */
export function sameRepository(project: string, directory: string): boolean {
  if (!existsSync(directory)) return false
  const common = (dir: string) => { try { return canonicalProject(resolve(dir, git(dir, ["rev-parse", "--git-common-dir"]))) } catch { return undefined } }
  const expected = common(project)
  return expected !== undefined && expected === common(directory)
}

/** `<repo>-wt/<name>` beside the main worktree, the convention AGENTS.md uses for task-owned worktrees. */
export function defaultWorktreePath(root: string, name: string): string {
  return join(dirname(root), `${basename(root)}-wt`, name)
}

/**
 * Creates (or reuses) the worktree at `path` on `branch`, cut from `base`'s HEAD.
 * An existing worktree of the same repository on that branch is reused as is.
 */
export function ensureWorktree(base: string, path: string, branch: string): void {
  if (!BRANCH.test(branch)) throw new Error(`Refusing worktree branch "${branch}": Iolaus branches are iolaus/<lowercase slug>`)
  if (existsSync(path)) {
    if (!sameRepository(base, path)) throw new Error(`${path} exists and is not a worktree of this repository`)
    const current = git(path, ["branch", "--show-current"])
    if (current !== branch) throw new Error(`${path} is a worktree on ${current || "a detached HEAD"}, not ${branch}`)
    return
  }
  const exists = (() => { try { git(base, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); return true } catch { return false } })()
  git(base, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"])
}

/** Copies an untracked path (plans live under a git-ignored directory) into the worktree when it is missing there. */
export function copyInto(base: string, worktree: string, relative: string): void {
  const target = join(worktree, relative)
  if (!existsSync(target) && existsSync(join(base, relative))) cpSync(join(base, relative), target, { recursive: true })
}
