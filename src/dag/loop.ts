import type { DagDefinition, DagLoop, DagNodeDefinition, DagRunRecord } from "./types"

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
  const fix: DagNodeDefinition = { ...executor, id: fixID, prompt: loop.executorPrompt.replaceAll("{round}", String(round)), dependsOn: [settled], inputs: [{ node: previousWork }, { node: settled }], when: undefined }
  const review: DagNodeDefinition = { ...reviewer, id: reviewID, prompt: loop.reviewerPrompt.replaceAll("{round}", String(round)), dependsOn: [fixID], inputs: [{ node: fixID }], when: undefined }
  const tail = new Set(loop.tail ?? [])
  const nodes = run.definition.nodes.map((node) => tail.has(node.id)
    ? { ...node, dependsOn: node.dependsOn.map((d) => d === settled ? reviewID : d), when: { node: reviewID, field: "text", includes: loop.passIncludes } }
    : node)
  return { ...run.definition, nodes: [...nodes.filter((node) => !tail.has(node.id)), fix, review, ...nodes.filter((node) => tail.has(node.id))] }
}

export function buildLoop(input: Omit<DagLoop, "tail"> & { readonly tail?: readonly string[] }): DagLoop {
  return input
}
