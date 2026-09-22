import type { TeamModeConfig } from "@oh-my-opencode/team-core"

import type { SessionDispatchGate } from "../../orchestration/session-dispatch-gate"

export type TeamTrace = (event: string, detail?: Record<string, unknown>) => void

export type TeamToolInput = {
  readonly type: "object"
  readonly properties: Record<string, unknown>
  readonly required?: readonly string[]
  readonly additionalProperties: false
}

export type TeamToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input: TeamToolInput
  readonly options?: { readonly codemode: false }
  readonly execute: (input: unknown, toolCtx: unknown) => Promise<{ readonly content: string }>
}

export type RegisterTeamModeOptions = {
  readonly cwd: string
  readonly gate: SessionDispatchGate
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
  readonly trace?: TeamTrace
}

export type TeamFeatureContext = {
  readonly options: Readonly<Record<string, unknown>>
  readonly tool: {
    transform(transformer: (draft: { add(tool: TeamToolDefinition): void }) => void | Promise<void>): Promise<unknown>
  }
  readonly event: {
    subscribe(): AsyncIterable<unknown>
  }
  readonly session: {
    create(input: { readonly agent?: string; readonly title?: string }): Promise<{ readonly id: string }>
    prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>
    synthetic(input: {
      readonly sessionID: string
      readonly text: string
      readonly description: string
      readonly metadata: Readonly<Record<string, string>>
      readonly delivery: "queue"
      readonly resume: true
    }): Promise<unknown>
    interrupt(input: { readonly sessionID: string }): Promise<unknown>
  }
}

export type TeamModeRegistration = {
  readonly config: TeamModeConfig
  readonly dispose: () => void
}

export type TeamParticipant = {
  readonly teamRunId: string
  readonly memberName: string
  readonly role: "lead" | "member"
}
