import type { CatalogEditor } from "@opencode/plugin/effect/catalog"
import { resolveModelPipeline } from "@oh-my-opencode/model-core"
import type { ModelRequirement } from "@oh-my-opencode/model-core"
import type { OpenCode2AgentOverride } from "../config"

/**
 * A point-in-time view of the harness model catalog. Feeds model-core's pure
 * resolution pipeline.
 */
export interface CatalogSnapshot {
  /** "<provider>/<model>" for every model the catalog lists. */
  availableModels: Set<string>;
  /** Providers that have at least one model registered in the catalog. */
  connectedProviders: string[];
  /**
   * Subset of `availableModels` whose capabilities accept image input. Drives
   * the `look_at` gate: a caller already on one of these needs no delegation.
   */
  visionModels: Set<string>;
  /** The harness's configured default model ("<provider>/<model>"), if any. */
  systemDefaultModel?: string;
}

function emptySnapshot(): CatalogSnapshot {
  return { availableModels: new Set(), connectedProviders: [], visionModels: new Set() }
}

/** Structural read of the capability block, tolerant of a catalog that omits it. */
interface CapabilityCarrier {
  capabilities?: { input?: readonly string[] }
}

const IMAGE_INPUT = "image"

function acceptsImageInput(model: CapabilityCarrier): boolean {
  return model.capabilities?.input?.includes(IMAGE_INPUT) === true
}

/** Read a catalog transform draft into a snapshot (pure). */
export function captureCatalogDraft(draft: CatalogEditor): CatalogSnapshot {
  const snapshot = emptySnapshot()
  for (const record of draft.provider.list()) {
    const providerID = record.provider.id as unknown as string
    snapshot.connectedProviders.push(providerID)
    for (const [modelID, model] of record.models) {
      const key = `${providerID}/${modelID as unknown as string}`
      snapshot.availableModels.add(key)
      if (acceptsImageInput(model)) snapshot.visionModels.add(key)
    }
  }
  const def = draft.model.default.get()
  if (def) {
    snapshot.systemDefaultModel = `${def.providerID as unknown as string}/${def.modelID as unknown as string}`
  }
  return snapshot
}

/**
 * Live handle to the harness catalog. The v2 catalog is populated
 * asynchronously (it is EMPTY at plugin setup; `catalog.updated` fires once
 * providers/models have loaded) and agent registration runs lazily on registry
 * materialization — so the catalog must be captured in a catalog.transform
 * callback that re-fires on updates, and agent models resolved inside the
 * agent.transform callback against the freshest snapshot held here.
 */
export interface CatalogSource {
  /** The most recently captured catalog. Empty until the catalog populates. */
  readonly current: CatalogSnapshot;
  /** Capture from a catalog transform draft; called once per update. */
  capture(draft: CatalogEditor): void;
}

/** Create an empty catalog source, to be fed by a catalog.transform callback. */
export function createCatalogSource(): CatalogSource {
  let snapshot = emptySnapshot()
  return {
    get current() {
      return snapshot
    },
    capture(draft) {
      snapshot = captureCatalogDraft(draft)
    },
  }
}

export interface ResolvedModel {
  model: string;
  variant?: string;
}

/**
 * Resolve an agent's model through model-core's pure pipeline. Returns the
 * system default model when no chain entry matches and the agent tolerates it,
 * or undefined to skip registration for hard-requirement agents with no model.
 */
export function resolveAgentModel(
  requirement: ModelRequirement | undefined,
  snapshot: CatalogSnapshot,
  systemDefaultModel?: string,
  override?: OpenCode2AgentOverride,
): ResolvedModel | undefined {
  if (override?.model !== undefined && override.model.includes("/")) {
    return { model: override.model, variant: override.variant }
  }

  // Mirror the v1 adapter's requiresProvider gate: on a warm catalog, an agent
  // whose required providers are all disconnected is skipped (not registered).
  // A cold catalog (first run, no provider data) proceeds to the chain so the
  // agent still registers at its first fallback.
  const requiredProviders = requirement?.requiresProvider
  if (requiredProviders && requiredProviders.length > 0 && snapshot.availableModels.size > 0) {
    const anyConnected = snapshot.connectedProviders.some((p) => requiredProviders.includes(p))
    if (!anyConnected) return undefined
  }

  const resolution = resolveModelPipeline(
    {
      intent: {},
      constraints: {
        availableModels: snapshot.availableModels,
        connectedProviders: snapshot.connectedProviders,
      },
      policy: { fallbackChain: requirement?.fallbackChain, systemDefaultModel },
    },
  )

  if (resolution) {
    return { model: resolution.model, variant: resolution.variant }
  }

  // Cold catalog (no connected providers / first run): fall back to the first
  // fallback-chain entry so the agent is still registered and resolvable later.
  const first = requirement?.fallbackChain?.[0]
  if (first && first.providers.length > 0) {
    return { model: `${first.providers[0]}/${first.model}`, variant: first.variant }
  }
  return undefined
}
