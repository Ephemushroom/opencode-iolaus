import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { applyDefaultModels, createDagController as createEffectController } from "../src/dag/controller"
import { promiseController } from "../src/dag/promise"
import { createOpenCodeDagRunner, runnerFromPromise, type DagRunnerPromise } from "../src/dag/runner"
import { DagRunnerError } from "../src/dag/errors"
import { validateDefinition } from "../src/dag/graph"
import { expandTemplate } from "../src/dag/templates"
import { nodeFingerprint } from "../src/dag/fingerprint"
import { ensureWorktree, sameRepository } from "../src/dag/worktree"
import { laneFallbacks, parseModelsConfig, resolveLane } from "../src/models"
import { compilePlan, parseStartWork } from "../src/roles/startwork"
import { loadPlan } from "../src/roles/plan"
import { compactionState } from "../src/compaction"
import { renderCategory, renderMode } from "../src/prompts/render"
import type { DagDefinition, DagNodeDefinition } from "../src/dag/types"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "iolaus-borrows-"))); directories.push(dir); return dir }

type ControllerOptions = Omit<Parameters<typeof createEffectController>[0], "runner"> & { readonly runner: DagRunnerPromise }
const controllerOf = (options: ControllerOptions) => promiseController(createEffectController({ ...options, databasePath: join(options.directory, "iolaus.db"), runner: runnerFromPromise(options.runner) }))
const def = (nodes: DagNodeDefinition[], extra: Partial<DagDefinition> = {}): DagDefinition => ({ schemaVersion: 1, name: "t", nodes, ...extra })

/** Each start records the node's agent/model/prompt; `reply` decides the outcome per call. */
function runner(reply: (call: { id: string; agent?: string; model?: string; prompt: string; n: number }) => string | Error) {
  const calls: { id: string; agent?: string; model?: string; prompt: string; n: number }[] = []
  const pending = new Map<string, (typeof calls)[number]>()
  const r: DagRunnerPromise = {
    async start(input) { const call = { id: input.node.id, agent: input.node.agent, model: input.node.model, prompt: input.prompt, n: calls.length }; calls.push(call); const sessionID = `s${calls.length}`; pending.set(sessionID, call); return { nodeID: input.node.id, attempt: input.attempt, sessionID } },
    async wait(ref) { const out = reply(pending.get(ref.sessionID)!); if (out instanceof Error) throw out; return { payload: { text: out } } },
    async cancel() {},
  }
  return { runner: r, calls }
}

const gitRepo = (dir: string) => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("init", "-q", "-b", "main"); git("config", "user.email", "q@a"); git("config", "user.name", "qa")
  writeFileSync(join(dir, "a.txt"), "a\n"); git("add", "."); git("commit", "-qm", "init")
}

test("a lane may configure a model chain: the first is the lane model, the rest are runtime fallbacks", () => {
  const config = parseModelsConfig({ categories: { quick: ["a/one#low", { model: "b/two" }, "c/three"] }, agents: { oracle: "d/four" } })
  expect(resolveLane("quick", config)).toEqual({ lane: "quick", source: "config", model: "a/one", variant: "low" })
  expect(laneFallbacks("quick", config)).toEqual(["b/two", "c/three"])
  expect(laneFallbacks("oracle", config)).toEqual([])
  // Requirement chains name providers the user may not have, so an unconfigured lane never falls back.
  expect(laneFallbacks("deep-low", {})).toEqual([])
  expect(() => parseModelsConfig({ categories: { quick: [] } })).toThrow(/at least one model/)
  expect(() => parseModelsConfig({ categories: { quick: ["a/one", "nope"] } })).toThrow(/quick\[1\]/)
  const filled = applyDefaultModels(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }, { id: "pinned", agent: "quick", model: "x/y", prompt: "p", dependsOn: [] }]), () => "a/one#low", () => ["b/two"])
  expect(filled.nodes[0]).toMatchObject({ model: "a/one#low", fallbackModels: ["b/two"] })
  expect(filled.nodes[1].fallbackModels).toBeUndefined()
  // Fallbacks are not part of what a node is: an authorized Atlas fingerprint survives them.
  expect(nodeFingerprint({ ...filled.nodes[0], fallbackModels: undefined })).toBe(nodeFingerprint(filled.nodes[0]))
})

test("a model failure moves the node down its chain; other failures and an exhausted chain fail as before", async () => {
  const { runner: r, calls } = runner((call) => call.model === "c/three" ? "done" : new DagRunnerError({ message: `provider 503 on ${call.model}`, model: true }))
  const controller = controllerOf({ directory: temp(), runner: r, defaultModel: () => "a/one", fallbackModels: () => ["b/two", "c/three"] })
  const run = await controller.create(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }]), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("completed")
  expect(calls.map((c) => c.model)).toEqual(["a/one", "b/two", "c/three"])
  expect(done.nodes[0].result?.provenance.model).toBe("c/three")
  const events = (await controller.snapshot(run.runID, "owner")).events.filter((e) => e.type === "node.fallback").map((e) => e.payload)
  expect(events).toEqual([{ from: "a/one", to: "b/two", message: "provider 503 on a/one" }, { from: "b/two", to: "c/three", message: "provider 503 on b/two" }])
  // A retried node starts again from its planned model.
  const retried = await controller.retry(run.runID, "owner", "n")
  expect(retried.nodes[0].definition.model).toBe("a/one")
  await controller.close()

  const other = runner(() => new DagRunnerError({ message: "admission refused" }))
  const plain = controllerOf({ directory: temp(), runner: other.runner, defaultModel: () => "a/one", fallbackModels: () => ["b/two"] })
  const failed = await plain.wait((await plain.create(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }]), "owner")).runID, "owner")
  expect(failed.status).toBe("failed")
  expect(other.calls.map((c) => c.model)).toEqual(["a/one"])
  await plain.close()
})

test("an empty reply is a model failure: it falls back, and without a chain it fails instead of passing downstream", async () => {
  const chained = runner((call) => call.model === "b/two" ? "real work" : "  ")
  const controller = controllerOf({ directory: temp(), runner: chained.runner, defaultModel: () => "a/one", fallbackModels: () => ["b/two"] })
  const done = await controller.wait((await controller.create(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }]), "owner")).runID, "owner")
  expect(done.status).toBe("completed")
  expect(chained.calls.map((c) => c.model)).toEqual(["a/one", "b/two"])
  await controller.close()

  const bare = runner((call) => call.id === "a" ? "" : "downstream ran")
  const second = controllerOf({ directory: temp(), runner: bare.runner })
  const run = await second.wait((await second.create(def([{ id: "a", agent: "quick", model: "a/one", prompt: "p", dependsOn: [] }, { id: "b", agent: "quick", model: "a/one", prompt: "p", dependsOn: ["a"] }]), "owner")).runID, "owner")
  expect(run.status).toBe("failed")
  expect(run.nodes.find((n) => n.definition.id === "a")?.error).toMatch(/empty reply/)
  expect(bare.calls.map((c) => c.id)).toEqual(["a"])
  await second.close()
})

test("a deep-low node that ends with ESCALATE: deep-high reruns on deep-high with its findings", async () => {
  const lanes: Record<string, string> = { "deep-low": "o/sol", "deep-high": "o/astra" }
  const { runner: r, calls } = runner((call) => call.agent === "deep-low" ? "Found two viable designs; the trade-off is not settled by evidence.\nESCALATE: deep-high" : "Settled: design B.")
  const controller = controllerOf({ directory: temp(), runner: r, defaultModel: (agent) => lanes[agent] })
  const run = await controller.create(def([{ id: "n", agent: "deep-low", prompt: "Decide the cache design", dependsOn: [] }]), "owner")
  const done = await controller.wait(run.runID, "owner")
  expect(done.status).toBe("completed")
  expect(calls.map((c) => [c.agent, c.model])).toEqual([["deep-low", "o/sol"], ["deep-high", "o/astra"]])
  expect(calls[1].prompt).toContain("Decide the cache design")
  expect(calls[1].prompt).toContain("<iolaus-escalation from=\"deep-low\">")
  expect(calls[1].prompt).toContain("Found two viable designs")
  expect(done.nodes[0].result?.provenance).toMatchObject({ agent: "deep-high", model: "o/astra" })
  expect((await controller.snapshot(run.runID, "owner")).events.some((e) => e.type === "node.escalated")).toBe(true)
  await controller.close()

  // Only deep-low escalates, and only when the deep-high lane has a model.
  const other = runner(() => "x\nESCALATE: deep-high")
  const quiet = controllerOf({ directory: temp(), runner: other.runner, defaultModel: (agent) => agent === "quick" ? "o/luna" : undefined })
  const settled = await quiet.wait((await quiet.create(def([{ id: "q", agent: "quick", prompt: "p", dependsOn: [] }, { id: "d", agent: "deep-low", model: "o/sol", prompt: "p", dependsOn: [] }]), "owner")).runID, "owner")
  expect(settled.status).toBe("completed")
  expect(other.calls.every((c) => c.agent !== "deep-high")).toBe(true)
  await quiet.close()
  expect(renderCategory("deep-low", "openai/gpt-5.5")).toContain("ESCALATE: deep-high")
  expect(renderCategory("quick", "openai/gpt-5.5")).not.toContain("ESCALATE: deep-high")
})

test("worktree nodes get their own branch and directory; a run directory must be a worktree of this repository", async () => {
  const root = temp()
  const repo = join(root, "repo")
  mkdirSync(repo)
  gitRepo(repo)
  const created: { directory: string }[] = []
  const native = createOpenCodeDagRunner({
    location: { directory: repo },
    generate: { text: () => Effect.succeed({ text: "" }) },
    session: { create: (input: { location: { directory: string } }) => { created.push(input.location); return Effect.succeed({ id: `ses_${created.length}` }) }, prompt: () => Effect.void, wait: () => Effect.void, get: () => Effect.succeed({ outcome: "succeeded" }), context: () => Effect.succeed([]), interrupt: () => Effect.void },
  } as never)
  await Effect.runPromise(native.start({ runID: "abcdef12-run", node: { id: "member1", agent: "deep-low", worktree: true, prompt: "p", dependsOn: [] }, prompt: "p", attempt: 1 }))
  const path = join(root, "repo-wt", "iolaus-abcdef12-member1")
  expect(created[0].directory).toBe(path)
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: path, encoding: "utf8" }).trim()).toBe("iolaus/abcdef12-member1")
  // A retry reuses the node's worktree.
  await Effect.runPromise(native.start({ runID: "abcdef12-run", node: { id: "member1", agent: "deep-low", worktree: true, prompt: "p", dependsOn: [] }, prompt: "p", attempt: 2 }))
  expect(created[1].directory).toBe(path)
  await Effect.runPromise(native.start({ runID: "r", node: { id: "plain", agent: "quick", prompt: "p", dependsOn: [] }, prompt: "p", attempt: 1, directory: path }))
  expect(created[2].directory).toBe(path)

  expect(sameRepository(repo, path)).toBe(true)
  expect(sameRepository(repo, root)).toBe(false)
  expect(() => ensureWorktree(repo, join(root, "x"), "main")).toThrow(/iolaus\//)
  expect(() => ensureWorktree(repo, join(root, "x"), "iolaus/../../etc")).toThrow()
  expect(() => validateDefinition(def([{ id: "j", kind: "judge", agent: "momus", worktree: true, prompt: "p", dependsOn: [] }]))).toThrow(/Only agent nodes/)
  expect(() => validateDefinition(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }], { directory: "relative/dir" }))).toThrow(/absolute/)

  const { runner: r, calls } = runner(() => "ok")
  const controller = controllerOf({ directory: repo, runner: r, defaultModel: () => "a/one" })
  await expect(controller.create(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }], { directory: root }), "owner")).rejects.toThrow(/not a worktree of this project's repository/)
  const run = await controller.wait((await controller.create(def([{ id: "n", agent: "quick", prompt: "p", dependsOn: [] }], { directory: path }), "owner")).runID, "owner")
  expect(run.status).toBe("completed")
  expect(calls).toHaveLength(1)
  // The worktree's own plugin instance finds the run as lineage for the child it serves, and nothing else of it.
  const worktreeSide = createEffectController({ directory: path, databasePath: join(repo, "iolaus.db"), runner: runnerFromPromise(r) })
  expect((await Effect.runPromise(worktreeSide.lineage(run.runID, "n", "s1")))?.runID).toBe(run.runID)
  expect(await Effect.runPromise(worktreeSide.lineage(run.runID, "n", "forged"))).toBeUndefined()
  expect(await Effect.runPromise(worktreeSide.list())).toHaveLength(0)
  await Effect.runPromise(worktreeSide.close)
  await controller.close()
})

test("/start-work flags compile into a worktree run that opens and ships the PR after the accept gate", () => {
  expect(parseStartWork("cache")).toEqual({ ok: true, args: { plan: "cache", worktree: false, makePr: false, ship: false } })
  expect(parseStartWork("cache --worktree ../wt/cache")).toEqual({ ok: true, args: { plan: "cache", worktree: true, worktreePath: "../wt/cache", makePr: false, ship: false } })
  expect(parseStartWork("--worktree cache")).toEqual({ ok: true, args: { plan: "cache", worktree: true, makePr: false, ship: false } })
  expect(parseStartWork("--ship")).toEqual({ ok: true, args: { plan: "", worktree: true, makePr: true, ship: true } })
  expect(parseStartWork("cache --force").ok).toBe(false)
  expect(parseStartWork("cache other").ok).toBe(false)

  const dir = temp()
  mkdirSync(join(dir, ".iolaus/plans/cache/tickets"), { recursive: true })
  writeFileSync(join(dir, ".iolaus/plans/cache/spec.md"), "# Cache\n")
  writeFileSync(join(dir, ".iolaus/plans/cache/tickets/01-a.md"), "# 01: A\n\n**Blocked by:** None\n")
  const plan = loadPlan(dir, "cache")
  if (!plan.ok) throw new Error(plan.errors.join())
  const plain = compilePlan(plan.plan, "abc")
  expect(plain.directory).toBeUndefined()
  expect(plain.nodes.map((n) => n.id)).toEqual(["t01", "review-standards", "review-spec", "fix", "accept"])
  const delivery = { directory: "/repo-wt/cache", branch: "iolaus/cache", root: "/repo", pr: true, ship: true }
  const shipped = compilePlan(plan.plan, "abc", delivery)
  validateDefinition(applyDefaultModels(shipped, () => "openai/gpt-5.5"))
  expect(shipped.directory).toBe("/repo-wt/cache")
  expect(shipped.nodes.map((n) => n.id)).toEqual(["t01", "review-standards", "review-spec", "fix", "accept", "pr", "ship"])
  expect(shipped.nodes.find((n) => n.id === "pr")).toMatchObject({ agent: "atlas", dependsOn: ["accept"] })
  expect(shipped.nodes.find((n) => n.id === "pr")?.prompt).toContain("gh pr create")
  expect(shipped.nodes.find((n) => n.id === "ship")?.prompt).toContain("gh pr merge --merge")
  expect(shipped.nodes.find((n) => n.id === "ship")?.prompt).toContain("git -C /repo worktree remove /repo-wt/cache")
  expect(compilePlan(plan.plan, "abc", { ...delivery, ship: false }).nodes.map((n) => n.id)).not.toContain("ship")
})

test("team template: a lead splits, members build in their own worktrees, the lead integrates on a branch, then review and gate", () => {
  const team = expandTemplate({ template: "team", task: "Build the export feature", members: ["deep-low", "deep-low", "visual-engineering"] })
  validateDefinition(applyDefaultModels(team, () => "openai/gpt-5.5"))
  expect(team.maxParallel).toBe(3)
  expect(team.nodes.map((n) => n.id)).toEqual(["split", "member1", "member2", "member3", "integrate", "review", "accept"])
  expect(team.nodes.filter((n) => n.worktree).map((n) => n.id)).toEqual(["member1", "member2", "member3", "integrate"])
  expect(team.nodes.find((n) => n.id === "member3")).toMatchObject({ agent: "visual-engineering", dependsOn: ["split"] })
  expect(team.nodes.find((n) => n.id === "integrate")).toMatchObject({ agent: "unspecified-high", dependsOn: ["member1", "member2", "member3"] })
  expect(team.nodes.find((n) => n.id === "review")?.kind).toBe("judge")
  expect(expandTemplate({ template: "team", task: "t", lead: "ultrabrain", gate: false }).nodes.map((n) => [n.id, n.agent])).toEqual([["split", "ultrabrain"], ["member1", "deep-low"], ["member2", "deep-low"], ["integrate", "ultrabrain"], ["review", "momus"]])
  expect(() => expandTemplate({ template: "team", task: "t", members: ["quick"] })).toThrow(/two to eight/)
  expect(() => expandTemplate({ template: "hyperplan", task: "t", members: ["quick", "quick"] })).toThrow(/distinct/)
  expect(renderMode("team", "openai/gpt-5.5")).toContain("<iolaus-team-mode>")
  expect(renderMode("team", "openai/gpt-5.5")).not.toContain("team_create")
})

test("compaction keeps the session's goal, role and unfinished runs, and nothing when there is none", () => {
  const run = (status: string, observed = false) => ({ runID: `r-${status}`, ownerSessionID: "s", name: `run ${status}`, fingerprint: "f", generation: 1, createdAt: 0, updatedAt: 0,
    status, definition: { schemaVersion: 1, name: "x", nodes: [], ...(observed ? { observed: true } : {}), ...(status === "paused" ? { directory: "/repo-wt/cache" } : {}) },
    nodes: [{ definition: { id: "a", prompt: "", dependsOn: [] }, fingerprint: "", status: "completed", attempt: 1 }, { definition: { id: "accept", kind: "gate", prompt: "", dependsOn: [] }, fingerprint: "", status: "waiting_approval", attempt: 1 }] }) as never
  const text = compactionState({ sessionID: "s", objective: "Ship the cache", status: "active", continuations: 2, stagnant: 0, createdAt: 0, updatedAt: 0 }, { role: "orchestrator", plan: "cache", runID: "r-paused" }, [run("paused"), run("completed"), run("running", true)])!
  expect(text).toContain("<iolaus-compaction-state>")
  expect(text).toContain("Session goal (active): Ship the cache")
  expect(text).toContain('Session role: orchestrator for plan "cache" (run r-paused)')
  expect(text).toContain('DAG run r-paused "run paused" is paused in /repo-wt/cache; open nodes: accept=waiting_approval (the user decides)')
  expect(text).not.toContain("r-completed")
  expect(text).not.toContain("r-running")
  expect(compactionState(null, undefined, [run("completed")])).toBeUndefined()
})
