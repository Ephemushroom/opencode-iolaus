import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { findAgentsMdUp } from "@oh-my-opencode/rules-engine"
import {
  createEngine,
  defaultConfig,
  findProjectRoot,
  findRuleCandidates,
} from "@oh-my-opencode/rules-engine/engine"

export interface ProjectRulesSystemPart {
  readonly type: "text"
  readonly text: string
}

export interface ProjectRulesContext {
  readonly systemParts: ProjectRulesSystemPart[]
  readonly ruleFiles: number
  readonly agentsFiles: number
  readonly diagnostics: number
}

export async function loadProjectRulesContext(workspaceDirectory: string): Promise<ProjectRulesContext> {
  const workspaceRoot = resolve(workspaceDirectory)
  const projectRoot = findProjectRoot(workspaceRoot) ?? workspaceRoot
  const engine = createEngine(defaultConfig(), {
    findCandidates: (options) => {
      const disabledSources = new Set(options.disabledSources)
      disabledSources.add("plugin-bundled")
      return findRuleCandidates({
        projectRoot: options.projectRoot,
        targetFile: options.targetFile,
        disabledSources,
        skipUserHome: true,
      })
    },
    findProjectRoot: () => projectRoot,
    readFile: readTextFile,
  })
  const staticResult = engine.loadStaticRules(workspaceRoot)
  const systemParts: ProjectRulesSystemPart[] = []
  const staticBlock = engine.formatStatic(staticResult.rules)
  if (staticBlock.length > 0) {
    systemParts.push({ type: "text", text: staticBlock })
  }

  const agentsPaths = await findAgentsMdUp({
    startDir: workspaceRoot,
    rootDir: projectRoot,
    skipRoot: false,
  })
  let agentsFiles = 0
  for (const agentsPath of agentsPaths) {
    const content = readTextFile(agentsPath)
    if (content === null) continue
    systemParts.push({
      type: "text",
      text: `Instructions from: ${agentsPath}\n\n${content.trim()}`,
    })
    agentsFiles += 1
  }

  return {
    systemParts,
    ruleFiles: staticResult.rules.length,
    agentsFiles,
    diagnostics: staticResult.diagnostics.length,
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
