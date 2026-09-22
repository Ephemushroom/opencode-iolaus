import { tokenizeCommand } from "./types"

export type TimerHandle = ReturnType<typeof setTimeout>

export interface ExitResult {
  code: number | null
  signal: string | null
}

export interface MonitoredProcess {
  kill(signal?: NodeJS.Signals): void
  exited: Promise<ExitResult>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

interface SpawnedProcess {
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly pid?: number | undefined
  readonly signalCode?: NodeJS.Signals | null | undefined
}

export type SpawnFunction = (
  argv: readonly string[],
  options: {
    readonly cwd?: string | undefined
    readonly detached: boolean
    readonly stdin: "ignore"
    readonly stdout: "pipe"
    readonly stderr: "pipe"
  },
) => SpawnedProcess

export interface SpawnDeps {
  spawn?: SpawnFunction
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

const KILL_GRACE_MS = 5_000

function defaultSpawn(argv: readonly string[], options: Parameters<SpawnFunction>[1]): SpawnedProcess {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  })
  return {
    exited: proc.exited,
    stdout: proc.stdout,
    stderr: proc.stderr,
    pid: proc.pid,
    signalCode: proc.signalCode,
  }
}

/**
 * Kills the whole process group so a shell wrapper cannot leave orphans behind.
 * Falls back to the single pid where process groups are unavailable.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process is already gone, which is the outcome kill wanted.
    }
  }
}

/**
 * Spawns a watcher process the PLUGIN owns.
 *
 * This deliberately does not go through opencode2's shell registry: `ctx.shell`
 * is only `{ hook("create.before") }`, and the enumerable ShellApi hangs off a
 * client the plugin never receives. Owning the child directly is what makes
 * monitors possible on the v2 API at all.
 */
export function spawnMonitoredProcess(
  opts: { command: string; cwd?: string | undefined; maxRuntimeMs: number },
  deps: SpawnDeps = {},
): MonitoredProcess {
  const argv = tokenizeCommand(opts.command)
  if (argv.length === 0) throw new Error("Cannot spawn an empty monitor command")

  const spawn = deps.spawn ?? defaultSpawn
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))

  const subprocess = spawn(argv, {
    cwd: opts.cwd,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let actualExited = false
  let publicExitSettled = false
  let watchdogTimer: TimerHandle | undefined
  let graceTimer: TimerHandle | undefined
  let resolvePublicExit: (result: ExitResult) => void = () => {}

  const publicExit = new Promise<ExitResult>((resolve) => {
    resolvePublicExit = resolve
  })

  const clearWatchdog = (): void => {
    if (watchdogTimer !== undefined) {
      clearTimer(watchdogTimer)
      watchdogTimer = undefined
    }
  }

  const clearGrace = (): void => {
    if (graceTimer !== undefined) {
      clearTimer(graceTimer)
      graceTimer = undefined
    }
  }

  const settle = (result: ExitResult): void => {
    if (publicExitSettled) return
    publicExitSettled = true
    resolvePublicExit(result)
  }

  const kill = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (actualExited) return
    if (subprocess.pid !== undefined) killTree(subprocess.pid, signal)
    if (graceTimer === undefined) {
      graceTimer = setTimer(() => {
        if (!actualExited && subprocess.pid !== undefined) killTree(subprocess.pid, "SIGKILL")
      }, KILL_GRACE_MS)
    }
  }

  watchdogTimer = setTimer(() => {
    clearWatchdog()
    kill("SIGTERM")
    settle({ code: null, signal: "SIGALRM" })
  }, opts.maxRuntimeMs)

  subprocess.exited
    .then((code) => {
      actualExited = true
      clearWatchdog()
      clearGrace()
      settle({ code, signal: subprocess.signalCode ?? null })
    })
    .catch(() => {
      actualExited = true
      clearWatchdog()
      clearGrace()
      settle({ code: null, signal: null })
    })

  return { kill, exited: publicExit, stdout: subprocess.stdout, stderr: subprocess.stderr }
}
