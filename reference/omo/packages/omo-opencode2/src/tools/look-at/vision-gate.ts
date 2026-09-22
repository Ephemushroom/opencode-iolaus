import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"

import type { CatalogSnapshot } from "../../agents/model-resolution"

/** Subagent that performs the looking when the caller cannot see images. */
export const LOOK_AT_AGENT = "multimodal-looker"

export type LookAtRoute =
  /** Caller already accepts image input; native `read` is the cheaper answer. */
  | { kind: "passthrough"; model: string }
  /** Caller is blind to images; a vision-capable model does the looking. */
  | { kind: "delegate"; model?: string; visionModel: string }
  /** Nothing in the catalog can see images, or the catalog is not loaded yet. */
  | { kind: "unavailable"; model?: string; reason: "no-vision-model" | "catalog-cold" }

/**
 * Pick a vision-capable model to delegate to.
 *
 * The caller's own provider comes first. v2's catalog lists models from every
 * provider it knows about, not just the ones the user holds credentials for, so
 * a chain-first choice happily selects a model the user cannot call. The
 * provider the caller is already running on is the one provider proven to
 * authenticate, which makes it the safest target. Only then does the
 * multimodal-looker chain apply, and finally any vision model, sorted for
 * determinism.
 */
export function selectVisionModel(snapshot: CatalogSnapshot, preferProvider?: string): string | undefined {
  if (snapshot.visionModels.size === 0) return undefined

  if (preferProvider) {
    const sameProvider = [...snapshot.visionModels]
      .filter((model) => model.startsWith(`${preferProvider}/`))
      .sort()
    if (sameProvider[0]) return sameProvider[0]
  }

  const chain = AGENT_MODEL_REQUIREMENTS[LOOK_AT_AGENT]?.fallbackChain ?? []
  for (const entry of chain) {
    for (const provider of entry.providers) {
      const candidate = `${provider}/${entry.model}`
      if (snapshot.visionModels.has(candidate)) return candidate
    }
  }

  return [...snapshot.visionModels].sort()[0]
}

/**
 * Decide how a `look_at` call should be served.
 *
 * This is the deliberate divergence from v1, which always delegated. v2's
 * native `read` renders images and PDFs to the model directly, so delegating
 * from a model that can already see the file wastes a child session.
 *
 * An unknown caller model is treated as blind rather than sighted: delegating
 * still produces a correct answer, whereas passthrough on a model that cannot
 * see the file produces a confident wrong one.
 */
export function resolveLookAtRoute(input: {
  sessionModel?: string
  snapshot: CatalogSnapshot
}): LookAtRoute {
  const { sessionModel, snapshot } = input

  if (sessionModel && snapshot.visionModels.has(sessionModel)) {
    return { kind: "passthrough", model: sessionModel }
  }

  const callerProvider = sessionModel?.split("/")[0]
  const visionModel = selectVisionModel(snapshot, callerProvider)
  if (visionModel) return { kind: "delegate", model: sessionModel, visionModel }

  return {
    kind: "unavailable",
    model: sessionModel,
    reason: snapshot.availableModels.size === 0 ? "catalog-cold" : "no-vision-model",
  }
}
