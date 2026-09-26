import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { loadVerifyConfig, MUTATION_TOOLS } from "./config"
import { mutatedPaths, renderReport, verify } from "./run"

export interface VerifyHost {
  readonly directory: (sessionID: string) => Promise<string>
  readonly trace?: (event: string, data: Record<string, unknown>) => void
  readonly inline?: unknown
}

type AfterEvent = {
  readonly tool: string
  readonly input: unknown
  readonly sessionID: string
  readonly agent: string
} & ({ readonly status: "completed"; result: { output?: unknown; content?: unknown } } | { readonly status: "error"; error: unknown })

/**
 * After a successful edit/write/patch, run the project's checkers on the changed
 * files and append any diagnostics to the tool result the model sees. Failures of
 * the hook itself never fail the edit.
 */
export function registerVerifyHook(ctx: { tool: Pick<Context["tool"], "hook"> }, host: VerifyHost): Effect.Effect<void, never, Scope.Scope> {
  return ctx.tool.hook("execute.after", (event) => Effect.promise(async () => {
    const e = event as unknown as AfterEvent
    if (!MUTATION_TOOLS.has(e.tool) || e.status !== "completed") return
    try {
      const directory = await host.directory(e.sessionID)
      const config = loadVerifyConfig(directory, host.inline)
      if (config.source === "disabled") return
      const paths = mutatedPaths(e.input, directory)
      if (!paths.length) {
        host.trace?.("iolaus.verify.skipped", { tool: e.tool, reason: "no paths in input", keys: typeof e.input === "object" && e.input ? Object.keys(e.input) : [] })
        return
      }
      const report = await verify(config, directory, paths)
      const text = renderReport(report)
      host.trace?.("iolaus.verify.ran", {
        tool: e.tool, agent: e.agent, paths: report.paths, source: config.source,
        checkers: report.checkers.map((c) => ({ name: c.name, ok: c.ok, diagnostics: c.diagnostics.length, durationMs: c.durationMs, error: c.error ?? null })),
        comments: report.comments.length,
      })
      if (!text) return
      const result = e.result
      if (typeof result.content === "string" || result.content === undefined) {
        result.content = `${result.content ?? (typeof result.output === "string" ? "" : "")}${text}`
      } else if (Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text }]
      }
      if (typeof result.output === "string" && result.content === undefined) result.output = `${result.output}${text}`
    } catch (error) {
      host.trace?.("iolaus.verify.failed", { tool: e.tool, error: String(error) })
    }
  })).pipe(Effect.asVoid)
}
