/**
 * Vendor → class → version prompt lanes.
 *
 * Iolaus previously picked a prompt variant from one flat predicate chain. That
 * chain could not express two things we need: two models in the same class with
 * different prompt versions (Opus 5 and Opus 5.5), and a policy for a model we
 * have never seen. This module keeps one ordered table and resolves in three
 * steps:
 *
 * 1. vendor: the provider prefix, or the model-name evidence when the provider
 *    is a reseller (`proxy-cc/claude-opus-5-5` is Anthropic).
 * 2. class: the model family inside the vendor — OpenAI `astra`/`sol`/`luna`/
 *    `terra`, Anthropic `opus`/`sonnet`/`haiku`/`fable`/`mythos`.
 * 3. version: the highest table version at or below the requested one, inside
 *    the same class only.
 *
 * A model never inherits another class's prompt. If the class has no table
 * entry, the lane is `undefined` and the caller falls back to its generic
 * prompt, which is safer than handing `haiku` a prompt tuned for `opus`.
 */

export type PromptVendor = "anthropic" | "openai" | "google" | "moonshot" | "xai" | "zhipu" | "deepseek" | "other";

/**
 * The prompt idiom a model is addressed in. Vendors without their own tuned
 * body borrow one: GLM, Kimi and DeepSeek currently borrow Anthropic's, so they
 * receive the same Claude-shaped prompt as an Opus or Fable model instead of
 * the generic fallback. Gemini, Grok and unknown carriers keep their retained
 * OMO variants.
 */
export type PromptIdiom = "anthropic" | "openai" | "google" | "xai" | "other";

export type AnthropicClass = "opus" | "sonnet" | "haiku" | "fable";
export type OpenAiClass = "astra" | "sol" | "luna" | "terra";
export type PromptClass = AnthropicClass | OpenAiClass;

export interface ModelIdentity {
  readonly vendor: PromptVendor;
  readonly className: PromptClass | undefined;
  /** Numeric version, most significant first. `5.5` is `[5, 5]`; unknown is `[]`. */
  readonly version: readonly number[];
  /** The descriptor the table matched, e.g. `gpt-6-astra` or `claude-opus-5-5`. */
  readonly descriptor: string;
}

export interface PromptLane {
  readonly vendor: PromptVendor;
  readonly className: PromptClass;
  readonly version: readonly number[];
  /** Prompt variant id, e.g. `claude-opus-5` or `gpt-6-astra`. */
  readonly lane: string;
}

/** Ordered by version ascending inside each class. Add new releases here. */
const LANES: readonly PromptLane[] = [
  { vendor: "anthropic", className: "opus", version: [4, 7], lane: "claude-opus-4-7" },
  { vendor: "anthropic", className: "opus", version: [4, 8], lane: "claude-opus-4-8" },
  { vendor: "anthropic", className: "opus", version: [5, 0], lane: "claude-opus-5" },
  { vendor: "anthropic", className: "opus", version: [5, 5], lane: "claude-opus-5-5" },
  { vendor: "anthropic", className: "fable", version: [5, 0], lane: "claude-fable-5" },
  // Fable 5.1 shares the Fable 5 body for now: its documented deltas are still
  // per-run behaviors to measure, not a separate prompt. The row exists so the
  // version is resolved by the table instead of falling back to the nearest row.
  { vendor: "anthropic", className: "fable", version: [5, 1], lane: "claude-fable-5" },
  { vendor: "openai", className: "astra", version: [6, 0], lane: "gpt-6-astra" },
  { vendor: "openai", className: "sol", version: [5, 4], lane: "gpt-5-4" },
  { vendor: "openai", className: "sol", version: [5, 5], lane: "gpt-5-5" },
  { vendor: "openai", className: "sol", version: [6, 1], lane: "gpt-5-5" },
  { vendor: "openai", className: "luna", version: [6, 0], lane: "gpt-5-5" },
  { vendor: "openai", className: "terra", version: [5, 6], lane: "gpt-5-5" },
]

const ANTHROPIC_PROVIDERS = ["anthropic", "claude", "proxy-cc"]
const OPENAI_PROVIDERS = ["openai", "azure", "proxy-codex", "codex"]

/** OpenAI codenames double as the class name, so one table covers the whole family. */
const OPENAI_CODENAMES: readonly OpenAiClass[] = ["astra", "sol", "luna", "terra"]

function providerOf(model: string): string {
  return model.includes("/") ? model.slice(0, model.indexOf("/")).toLowerCase() : ""
}

function nameOf(model: string): string {
  const name = model.includes("/") ? (model.split("/").pop() ?? model) : model
  return name.toLowerCase().replaceAll(".", "-")
}

function numbers(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((value) => !Number.isNaN(value))
}

function parseOpenAi(name: string): { className: OpenAiClass; version: number[]; descriptor: string } | undefined {
  for (const codename of OPENAI_CODENAMES) {
    const match = new RegExp(`gpt-(\\d+(?:-\\d+)*)-${codename}(?:$|[^a-z])`).exec(name)
    if (match) return { className: codename, version: numbers(match[1] ?? ""), descriptor: `gpt-${match[1]}-${codename}` }
  }
  // A bare version with no codename is the flagship class. GPT-5.x predates
  // the codenames, so it resolves to `sol`, whose prompt is the retained body.
  const bare = /gpt-(\d+(?:-\d+)*)(?:$|[^a-z])/.exec(name)
  if (bare) return { className: "sol", version: numbers(bare[1] ?? ""), descriptor: `gpt-${bare[1]}` }
  return undefined
}

function parseAnthropic(name: string): { className: AnthropicClass; version: number[]; descriptor: string } | undefined {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d+(?:-\d+)*))?/.exec(name)
  if (!match) return undefined
  let className: AnthropicClass = (match[1] === "mythos" ? "fable" : match[1]) as AnthropicClass
  const version = numbers(match[2] ?? "")
  return { className, version, descriptor: `claude-${match[1]}${match[2] ? `-${match[2]}` : ""}` }
}

export function identifyModel(model: string): ModelIdentity {
  const provider = providerOf(model)
  const name = nameOf(model)
  const anthropic = parseAnthropic(name)
  const openai = parseOpenAi(name)
  // The model name is stronger evidence than the provider: resellers and
  // OpenAI-compatible gateways serve Claude and GPT models under their own ids.
  const vendor: PromptVendor =
    anthropic ? "anthropic"
    : openai ? "openai"
    // A gateway id such as `ds-bryan/anthropic-v4-flash` carries the vendor in the
    // name without a `claude-*` model id; the name still decides the vendor.
    : name.includes("anthropic") ? "anthropic"
    : name.includes("gemini") ? "google"
    : name.includes("kimi") || name.includes("moonshot") ? "moonshot"
    : name.includes("grok") ? "xai"
    : name.includes("glm") ? "zhipu"
    : name.includes("deepseek") ? "deepseek"
    : ANTHROPIC_PROVIDERS.includes(provider) ? "anthropic"
    : OPENAI_PROVIDERS.includes(provider) ? "openai"
    : "other"
  const matched = vendor === "anthropic" ? anthropic : vendor === "openai" ? openai : undefined
  return {
    vendor,
    className: matched?.className,
    version: matched?.version ?? [],
    descriptor: matched?.descriptor ?? name,
  }
}

/**
 * The idiom a model's prompt should be written in.
 *
 * Only Anthropic and OpenAI have a table of tuned bodies. GLM, Kimi and
 * DeepSeek borrow the Anthropic idiom deliberately: their own OMO bodies were
 * tuned for an older harness and diverged from the behavior we want, so until
 * there is a measured reason to split them they receive the Claude-shaped
 * prompt. That is a routing decision, not a claim that a Kimi model is Claude:
 * the body still names the model that is actually running.
 */
export function resolvePromptIdiom(model: string): PromptIdiom {
  const { vendor } = identifyModel(model)
  switch (vendor) {
    case "anthropic": return "anthropic"
    case "openai": return "openai"
    case "google": return "google"
    case "xai": return "xai"
    case "moonshot":
    case "zhipu":
    case "deepseek":
      return "anthropic"
    default: return "other"
  }
}

function compare(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * The lane for a model, or `undefined` when the class has no entry. Resolution
 * never crosses classes and never guesses a version above the requested one.
 */
export function resolvePromptLane(model: string): PromptLane | undefined {
  const identity = identifyModel(model)
  if (!identity.className) return undefined
  const candidates = LANES
    .filter((lane) => lane.vendor === identity.vendor && lane.className === identity.className)
    .sort((left, right) => compare(left.version, right.version))
  if (candidates.length === 0) return undefined
  // Highest entry not newer than the model. A model older than the first entry
  // still gets that entry: the class contract is the closest thing we have.
  let chosen = candidates[0]
  for (const lane of candidates) {
    if (compare(lane.version, identity.version) <= 0) chosen = lane
  }
  if (identity.version.length > 0 && compare(chosen.version, identity.version) > 0) chosen = candidates[0]
  return chosen
}

/** Every lane in the table, for tests and diagnostics. */
export function promptLanes(): readonly PromptLane[] {
  return LANES
}
