/**
 * Hephaestus model-family prompt routing (pure).
 *
 * Harness-agnostic: selects the GPT prompt variant for the resolved model and
 * assembles the full system prompt (identity + variant body). The
 * harness-coupled agent-config factory lives in the adapter layer.
 */

import { isGpt5_5Model, isGpt5_6Model, isGpt6Model } from "../types";
import type {
  AvailableAgent,
  AvailableTool,
  AvailableSkill,
  AvailableCategory,
} from "../dynamic-agent-prompt-builder";
import { buildAgentIdentitySection } from "../dynamic-agent-prompt-builder";

import { buildHephaestusPrompt as buildGptPrompt } from "./gpt";
import { buildHephaestusPrompt as buildGpt54Prompt } from "./gpt-5-4";
import { buildGpt55HephaestusPrompt as buildGpt55Prompt } from "./gpt-5-5";
import { buildGpt56HephaestusPrompt as buildGpt56Prompt } from "./gpt-5-6";

const GPT_5_3_CODEX_RE = /^gpt-5[.-]3-codex(?:$|[.-])/i;
const GPT_5_4_RE = /^gpt-5[.-]4(?:$|[.-])/i;
const GPT_5_5_RE = /^gpt-5[.-]5(?:$|[.-])/i;
const GPT_5_6_RE = /^gpt-5[.-]6(?:$|[.-])/i;
const GPT_6_RE = /^gpt-6(?:$|[.-])/i;
const HOSTED_VENDOR_PREFIX_RE = /^(?:[^./]+\.)+(gpt-5[.-].*)$/i;

export type HephaestusPromptSource = "gpt-5-6" | "gpt-5-5" | "gpt-5-4" | "gpt";

export class UnsupportedHephaestusModelError extends Error {
  readonly model: string | undefined;

  constructor(model: string | undefined) {
    super(
      `Hephaestus only supports GPT-5.3 Codex, GPT-5.4, GPT-5.5, and GPT-5.6 models; received ${model ?? "no model"}.`,
    );
    this.name = "UnsupportedHephaestusModelError";
    this.model = model;
  }
}

function extractModelName(model: string): string {
  const afterProvider = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return HOSTED_VENDOR_PREFIX_RE.exec(afterProvider)?.[1] ?? afterProvider;
}

export function isHephaestusSupportedModel(model: string | undefined): boolean {
  if (!model) return false;
  const modelName = extractModelName(model);
  return (
    GPT_5_3_CODEX_RE.test(modelName) ||
    GPT_5_4_RE.test(modelName) ||
    GPT_5_5_RE.test(modelName) ||
    GPT_5_6_RE.test(modelName) ||
    GPT_6_RE.test(modelName)
  );
}

function assertHephaestusSupportedModel(model: string | undefined): void {
  if (!isHephaestusSupportedModel(model)) {
    throw new UnsupportedHephaestusModelError(model);
  }
}

export function getHephaestusPromptSource(
  model?: string,
): HephaestusPromptSource {
  assertHephaestusSupportedModel(model);
  if (model && (isGpt5_6Model(model) || isGpt6Model(model))) {
    return "gpt-5-6";
  }
  if (model && isGpt5_5Model(model)) {
    return "gpt-5-5";
  }
  if (model && GPT_5_4_RE.test(extractModelName(model))) {
    return "gpt-5-4";
  }
  return "gpt";
}

export interface HephaestusContext {
  model?: string;
  availableAgents?: AvailableAgent[];
  availableTools?: AvailableTool[];
  availableSkills?: AvailableSkill[];
  availableCategories?: AvailableCategory[];
  useTaskSystem?: boolean;
}

export function getHephaestusPrompt(
  model?: string,
  useTaskSystem = false,
): string {
  return buildDynamicHephaestusPrompt({ model, useTaskSystem });
}

export function buildDynamicHephaestusPrompt(ctx?: HephaestusContext): string {
  const agents = ctx?.availableAgents ?? [];
  const tools = ctx?.availableTools ?? [];
  const skills = ctx?.availableSkills ?? [];
  const categories = ctx?.availableCategories ?? [];
  const useTaskSystem = ctx?.useTaskSystem ?? false;
  const model = ctx?.model;

  const source = getHephaestusPromptSource(model);

  let basePrompt: string;
  switch (source) {
    case "gpt-5-6":
      basePrompt = buildGpt56Prompt(
        agents,
        tools,
        skills,
        categories,
        useTaskSystem,
      );
      break;
    case "gpt-5-5":
      basePrompt = buildGpt55Prompt(
        agents,
        tools,
        skills,
        categories,
        useTaskSystem,
      );
      break;
    case "gpt-5-4":
      basePrompt = buildGpt54Prompt(
        agents,
        tools,
        skills,
        categories,
        useTaskSystem,
      );
      break;
    case "gpt":
    default:
      basePrompt = buildGptPrompt(
        agents,
        tools,
        skills,
        categories,
        useTaskSystem,
      );
      break;
  }

  const agentIdentity = buildAgentIdentitySection(
    "Hephaestus",
    "Autonomous deep worker for software engineering from OhMyOpenCode",
  );

  return `${agentIdentity}\n${basePrompt}`;
}
