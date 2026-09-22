import { loadPromptSync, prometheusPromptVariants } from "@oh-my-opencode/prompts-core"

/**
 * The Prometheus system prompt (model-agnostic; v1 does not vary it by model).
 * Sourced from prompts-core's bundled `prompts/prometheus/default.md`.
 */
export function getPrometheusPrompt(): string {
  return loadPromptSync({
    source: prometheusPromptVariants.default,
    name: "prometheus",
    variant: "default",
  }).body
}
