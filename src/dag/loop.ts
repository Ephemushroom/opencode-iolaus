import type { DagCondition, DagDefinition, DagLoop, DagNodeDefinition, DagRunRecord } from "./types"

function roundOf(id: string, base: string): number | undefined {
  if (id === base) return 0
  if (!id.startsWith(base)) return undefined
  const n = Number(id.slice(base.length))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** The newest review node id in the loop and how many fix rounds already exist. */
export function loopState(definition: DagDefinition): { readonly latestReview: string; readonly rounds: number } | undefined {
  const loop = definition.loop
  if (!loop) return undefined
  let latestReview = loop.review, latestRound = 0, rounds = 0
  for (const node of definition.nodes) {
    const r = roundOf(node.id, loop.review)
    if (r !== undefined && r > latestRound) { latestRound = r; latestReview = node.id }
    if (roundOf(node.id, loop.fix) !== undefined && node.id !== loop.fix) rounds++
    if (node.id === loop.fix) rounds = Math.max(rounds, 1)
  }
  return { latestReview, rounds }
}

function textOf(run: DagRunRecord, nodeID: string): string {
  const payload = run.nodes.find((node) => node.definition.id === nodeID)?.result?.payload
  if (typeof payload === "string") return payload
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.text === "string") return payload.text
  return payload === undefined || payload === null ? "" : JSON.stringify(payload)
}

/**
 * If `settled` is the loop's newest review and it failed with rounds left, return
 * the definition with the next fix/review pair appended and the tail rewired to
 * the new review. Otherwise undefined.
 */
export function growLoop(run: DagRunRecord, settled: string): DagDefinition | undefined {
  const loop = run.definition.loop
  const state = loopState(run.definition)
  if (!loop || !state || settled !== state.latestReview) return undefined
  const record = run.nodes.find((node) => node.definition.id === settled)
  if (!record || record.status !== "completed") return undefined
  const text = textOf(run, settled)
  if (!text.includes(loop.failIncludes) || text.includes(loop.passIncludes)) return undefined
  if (state.rounds >= loop.maxRounds) return undefined
  const round = state.rounds
  const fixID = `${loop.fix}${round}`, reviewID = `${loop.review}${round}`
  const reviewer = run.definition.nodes.find((node) => node.id === loop.review)!
  const executor = run.definition.nodes.find((node) => node.id === loop.fix)!
  const previousWork = round === 1 ? loop.fix : `${loop.fix}${round - 1}`
  const fix: DagNodeDefinition = { ...executor, id: fixID, title: `Fix round ${round}`, prompt: loop.executorPrompt.replaceAll("{round}", String(round)), dependsOn: [settled], inputs: [{ node: previousWork }, { node: settled }], when: undefined }
  // A fresh judge call per round: it sees the fixed work and the blockers the previous review cited.
  const review: DagNodeDefinition = { ...reviewer, id: reviewID, title: `Review round ${round}`, prompt: loop.reviewerPrompt.replaceAll("{round}", String(round)), dependsOn: [fixID], inputs: [{ node: fixID }, { node: settled }], when: undefined }
  const tail = new Set(loop.tail ?? [])
  // Tail nodes follow the newest review, and their inputs naming the previous work read the newest work.
  const nodes = run.definition.nodes.map((node) => tail.has(node.id)
    ? {
        ...node,
        dependsOn: node.dependsOn.map((d) => d === settled ? reviewID : d),
        ...(node.dependsOn.includes(settled) ? { when: { node: reviewID, field: "text", includes: loop.passIncludes } } : {}),
        ...(node.inputs ? { inputs: node.inputs.map((input) => input.node === previousWork ? { ...input, node: fixID } : input.node === settled ? { ...input, node: reviewID } : input) } : {}),
      }
    : node)
  return { ...run.definition, nodes: [...nodes.filter((node) => !tail.has(node.id)), fix, review, ...nodes.filter((node) => tail.has(node.id))] }
}

function renamed(condition: DagCondition, rename: (id: string) => string): DagCondition {
  if ("all" in condition) return { all: condition.all.map((value) => renamed(value, rename)) }
  if ("any" in condition) return { any: condition.any.map((value) => renamed(value, rename)) }
  if ("not" in condition) return { not: renamed(condition.not, rename) }
  return { ...condition, node: rename(condition.node) }
}

/**
 * The inverse of `growLoop`: when the reviews in `rerun` are about to run again, the rounds grown after the
 * earliest of them answered a verdict that no longer exists. Returns the definition without those rounds and
 * with the tail following that review again, or undefined when no grown round is affected.
 */
export function shrinkLoop(definition: DagDefinition, rerun: ReadonlySet<string>): DagDefinition | undefined {
  const loop = definition.loop
  if (!loop) return undefined
  const rounds = definition.nodes.flatMap((node) => { const round = rerun.has(node.id) ? roundOf(node.id, loop.review) : undefined; return round === undefined ? [] : [round] })
  if (!rounds.length) return undefined
  const keep = Math.min(...rounds)
  const later = (id: string, base: string) => { const round = roundOf(id, base); return round !== undefined && round > keep }
  const dropped = new Set(definition.nodes.filter((node) => later(node.id, loop.fix) || later(node.id, loop.review)).map((node) => node.id))
  if (!dropped.size) return undefined
  const at = (base: string) => keep === 0 ? base : `${base}${keep}`
  const rename = (id: string) => !dropped.has(id) ? id : later(id, loop.review) ? at(loop.review) : at(loop.fix)
  return { ...definition, nodes: definition.nodes.filter((node) => !dropped.has(node.id)).map((node) => (loop.tail ?? []).includes(node.id) ? {
    ...node,
    dependsOn: [...new Set(node.dependsOn.map(rename))],
    ...(node.when ? { when: renamed(node.when, rename) } : {}),
    ...(node.inputs ? { inputs: node.inputs.map((input) => ({ ...input, node: rename(input.node) })) } : {}),
  } : node) }
}

export function buildLoop(input: Omit<DagLoop, "tail"> & { readonly tail?: readonly string[] }): DagLoop {
  return input
}
