import type { Context } from "@opencode/plugin/tui/context"
import type { DagViewNode } from "./view"

export function sessionUnavailable(node: Pick<DagViewNode, "kind" | "sessionID" | "status"> | undefined): string | undefined {
  if (!node) return "Select a node to open its session."
  if (node.kind === "gate") return "Human gates do not have an agent session."
  if (node.kind === "judge" || node.sessionID?.startsWith("judge:")) return "Judge nodes use a model call without a session."
  if (!node.sessionID) return ["pending", "starting"].includes(node.status) ? "The agent session is not available yet." : "No agent session was recorded for this node."
  return undefined
}

export async function openNodeSession(ui: Pick<Context["ui"], "router" | "dialog" | "toast">, node: DagViewNode | undefined): Promise<boolean> {
  const unavailable = sessionUnavailable(node)
  if (unavailable) {
    ui.toast.show({ variant: "info", title: "Iolaus Flow", message: unavailable })
    return false
  }
  try {
    await ui.router.navigate({ type: "session", sessionID: node!.sessionID! })
    ui.dialog.clear()
    return true
  } catch (error) {
    ui.toast.show({ variant: "error", title: "Iolaus Flow", message: `Could not open agent session: ${error instanceof Error ? error.message : String(error)}` })
    return false
  }
}
