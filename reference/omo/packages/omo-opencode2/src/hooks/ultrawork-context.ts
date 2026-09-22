import {
  HYPERPLAN_MODE_PROMPT,
  ULTRAWORK_DEFAULT_PROMPT,
  ULTRAWORK_GEMINI_PROMPT,
  ULTRAWORK_GLM_PROMPT,
  ULTRAWORK_GPT_PROMPT,
  ULTRAWORK_PLANNER_PROMPT,
} from "@oh-my-opencode/prompts-core"
import { isGeminiModel, isGlmModel, isGptModel } from "@oh-my-opencode/agents-core"

/** The structural tag used for idempotency checks across system parts. */
const ULTRAWORK_MODE_TAG = "<ultrawork-mode>"
const HYPERPLAN_MODE_TAG = "<hyperplan-mode>"
const HYPERPLAN_ULTRAWORK_MODE_TAG = "<hyperplan-ultrawork-mode>"

const ULTRAWORK_KEYWORD_PATTERN = /\b(ultrawork|ulw)\b/i
const HYPERPLAN_KEYWORD_PATTERN = /\bhyperplan\b|(?<![\w.])hpp\b/i
const HYPERPLAN_ULTRAWORK_PATTERN =
  /\b(?:hpp|hyperplan)\s+(?:ulw|ultrawork)\b|\b(?:ulw|ultrawork)\s+(?:hpp|hyperplan)\b/i
const HYPERPLAN_ULTRAWORK_BANNER = `<hyperplan-ultrawork-mode>
**MANDATORY**: Say "HYPERPLAN ULTRAWORK MODE ENABLED!" exactly once as your first response. Do NOT say the standalone "ULTRAWORK MODE ENABLED!" or "HYPERPLAN MODE ENABLED!" banners.

Apply the ultrawork protocol below as your execution framework. You MUST ALSO load the hyperplan skill immediately via \`skill(name="hyperplan")\` and follow its full adversarial workflow. Do not improvise, skip rounds, or write the plan yourself.
</hyperplan-ultrawork-mode>`
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const INLINE_CODE_PATTERN = /`[^`]+`/g
const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/

/**
 * Detects an ultrawork/ulw request in a user message. Code blocks, inline code,
 * and slash-command leads are stripped before matching (v1 parity).
 */
function sanitizeKeywordInput(text: string): string | undefined {
  const withoutCodeBlocks = text.replace(CODE_BLOCK_PATTERN, "")
  const clean = withoutCodeBlocks.replace(INLINE_CODE_PATTERN, "")
  return SLASH_COMMAND_LEAD_PATTERN.test(clean) ? undefined : clean
}

export type KeywordMode = "ultrawork" | "hyperplan" | "hyperplan-ultrawork"

/** Resolves v1 keyword modes, including strict-adjacency combo suppression. */
export function detectKeywordModes(text: string): KeywordMode[] {
  const clean = sanitizeKeywordInput(text)
  if (clean === undefined) return []
  if (HYPERPLAN_ULTRAWORK_PATTERN.test(clean)) return ["hyperplan-ultrawork"]

  const modes: KeywordMode[] = []
  if (ULTRAWORK_KEYWORD_PATTERN.test(clean)) modes.push("ultrawork")
  if (HYPERPLAN_KEYWORD_PATTERN.test(clean)) modes.push("hyperplan")
  return modes
}

export function detectUltraworkIntent(text: string): boolean {
  return detectKeywordModes(text).some((mode) => mode === "ultrawork" || mode === "hyperplan-ultrawork")
}

export interface UltraworkRoute {
  route: "planner" | "gpt" | "gemini" | "glm" | "default"
  text: string
}

function isPlannerAgent(agent: string | undefined): boolean {
  if (!agent) return false
  const lower = agent.toLowerCase()
  if (lower.includes("prometheus") || lower.includes("planner")) return true
  return /\bplan\b/.test(lower.replace(/[_-]+/g, " "))
}

/**
 * Selects the model-family ultrawork prompt (v1 routing order): planner agent
 * first, then gpt / gemini / glm / default by model family. Only the planner
 * variant needs the structural wrapper (the others carry the tag already).
 */
export function selectUltraworkPrompt(input: { agent?: string; model?: string }): UltraworkRoute {
  if (isPlannerAgent(input.agent)) {
    return {
      route: "planner",
      text: `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

${ULTRAWORK_PLANNER_PROMPT}

</ultrawork-mode>

`,
    }
  }
  if (input.model && isGptModel(input.model)) {
    return { route: "gpt", text: ULTRAWORK_GPT_PROMPT }
  }
  if (input.model && isGeminiModel(input.model)) {
    return { route: "gemini", text: ULTRAWORK_GEMINI_PROMPT }
  }
  if (input.model && isGlmModel(input.model)) {
    return { route: "glm", text: ULTRAWORK_GLM_PROMPT }
  }
  return { route: "default", text: ULTRAWORK_DEFAULT_PROMPT }
}

export interface UltraworkInjectionResult {
  system: Array<{ type: string; text?: string; [key: string]: unknown }>
  injected: boolean
}

function containsTag(system: UltraworkInjectionResult["system"], tag: string): boolean {
  return system.some((part) => typeof part.text === "string" && part.text.includes(tag))
}

/**
 * Appends one <ultrawork-mode> system part if (and only if) no system part
 * already carries the tag. Idempotent across repeated context calls.
 */
export function injectUltraworkSystemPart(
  system: Array<{ type: string; text?: string; [key: string]: unknown }>,
  input: { agent?: string; model?: string },
): UltraworkInjectionResult {
  if (containsTag(system, ULTRAWORK_MODE_TAG)) {
    return { system, injected: false }
  }
  const selection = selectUltraworkPrompt(input)
  return { system: [...system, { type: "text", text: selection.text }], injected: true }
}

function injectHyperplanSystemPart(system: UltraworkInjectionResult["system"]): UltraworkInjectionResult {
  if (containsTag(system, HYPERPLAN_MODE_TAG) || containsTag(system, HYPERPLAN_ULTRAWORK_MODE_TAG)) {
    return { system, injected: false }
  }
  return { system: [...system, { type: "text", text: HYPERPLAN_MODE_PROMPT }], injected: true }
}

function injectHyperplanUltraworkSystemPart(
  system: UltraworkInjectionResult["system"],
  input: { agent?: string; model?: string },
): UltraworkInjectionResult {
  if (containsTag(system, HYPERPLAN_ULTRAWORK_MODE_TAG)) return { system, injected: false }

  const withoutStandaloneModes = system.filter(
    (part) => !part.text?.includes(HYPERPLAN_MODE_TAG) && !part.text?.includes(ULTRAWORK_MODE_TAG),
  )
  const selection = selectUltraworkPrompt(input)
  const combo = `${HYPERPLAN_ULTRAWORK_BANNER}\n\n${selection.text}`
  return { system: [...withoutStandaloneModes, { type: "text", text: combo }], injected: true }
}

/** Appends the resolved standalone mode parts or one v1-compatible combo part. */
export function injectKeywordSystemParts(
  system: UltraworkInjectionResult["system"],
  modes: readonly KeywordMode[],
  input: { agent?: string; model?: string },
): UltraworkInjectionResult["system"] {
  if (modes.includes("hyperplan-ultrawork")) {
    return injectHyperplanUltraworkSystemPart(system, input).system
  }

  let output = system
  if (modes.includes("ultrawork")) output = injectUltraworkSystemPart(output, input).system
  if (modes.includes("hyperplan")) output = injectHyperplanSystemPart(output).system
  return output
}
