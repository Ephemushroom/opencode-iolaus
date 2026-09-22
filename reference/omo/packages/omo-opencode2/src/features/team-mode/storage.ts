import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  TeamSpecSchema,
  getTeamSpecPath,
  normalizeTeamSpecInput,
  resolveBaseDir,
  validateSpec,
  type TeamModeConfig,
  type TeamSpec,
} from "@oh-my-opencode/team-core"

import { createTeamCoreConfig } from "./config"

const DEFAULT_MEMBER_AGENT = "sisyphus-junior"

type JsonRecord = Record<string, unknown>

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function withDefaultMemberAgents(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return raw
  return {
    ...raw,
    members: raw.members.map((member) => {
      if (!isRecord(member)) return member
      if (member.kind !== undefined || member.category !== undefined || member.subagent_type !== undefined) return member
      return { ...member, kind: "subagent_type", subagent_type: DEFAULT_MEMBER_AGENT }
    }),
  }
}

export function parseInlineTeamSpec(raw: unknown): TeamSpec {
  const withDefaults = withDefaultMemberAgents(raw)
  const prepared = isRecord(withDefaults)
    ? {
      ...withDefaults,
      lead: {
        name: "lead",
        kind: "subagent_type",
        subagent_type: "sisyphus",
      },
    }
    : raw
  const parsed = TeamSpecSchema.safeParse(normalizeTeamSpecInput(prepared))
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    throw new Error(`Invalid team spec: ${issues.join("; ")}`)
  }
  validateSpec(parsed.data)
  return parsed.data
}

export async function persistProjectTeamSpec(
  cwd: string,
  spec: TeamSpec,
  config: TeamModeConfig,
): Promise<string> {
  const specPath = getTeamSpecPath(resolveBaseDir(config), spec.name, "project", cwd)
  await mkdir(dirname(specPath), { recursive: true, mode: 0o700 })
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  return specPath
}

export { createTeamCoreConfig }
