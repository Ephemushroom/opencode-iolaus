import type { TeamModeConfig } from "@oh-my-opencode/team-core"

import { TeamMailbox } from "./mailbox"
import { inputRecord, optionalString, requiredString } from "./tool-input"
import type { TeamToolDefinition } from "./types"

type MessageToolOptions = {
  readonly config: TeamModeConfig
  readonly mailbox: TeamMailbox
  readonly resolveSessionID: (toolCtx: unknown) => string | undefined
}

export function createTeamMessageTool(options: MessageToolOptions): TeamToolDefinition {
  return {
    name: "team_send_message",
    description: "Send a message to one team member or broadcast to all members when called by the lead.",
    input: {
      type: "object",
      properties: {
        teamRunId: { type: "string" },
        to: { type: "string", description: "Recipient member name, or * for a lead-only broadcast." },
        body: { type: "string" },
        kind: { type: "string", enum: ["message", "announcement"] },
        summary: { type: "string" },
      },
      required: ["teamRunId", "to", "body"],
      additionalProperties: false,
    },
    execute: async (raw, toolCtx) => {
      const input = inputRecord(raw)
      const senderSessionID = options.resolveSessionID(toolCtx)
      if (!senderSessionID) throw new Error("session ID is required")
      const kind = optionalString(input, "kind") === "announcement" ? "announcement" : "message"
      const result = await options.mailbox.send({
        teamRunId: requiredString(input, "teamRunId"),
        senderSessionID,
        to: requiredString(input, "to"),
        body: requiredString(input, "body"),
        kind,
        summary: optionalString(input, "summary"),
      })
      return { content: JSON.stringify(result) }
    },
  }
}
