import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, onMount } from "solid-js"
import { IOLAUS_DAG_RPC, type DagView } from "./dag/rpc"
import { trace } from "./trace"

type DagViewRun = DagView["runs"][number]

function statusGlyph(status: string): string {
  switch (status) {
    case "completed": return "✓"
    case "paused": return "⏸"
    case "failed": return "!"
    case "cancelled": return "×"
    case "interrupted": return "?"
    default: return "•"
  }
}

function DagSidebar(props: { readonly sessionID: string; readonly client: Context["client"] }) {
  const [runs, setRuns] = createSignal<readonly DagViewRun[]>([])
  const rpc = props.client.rpc(IOLAUS_DAG_RPC)
  const refresh = async () => {
    const result = await rpc.snapshot({ sessionID: props.sessionID }) as unknown as { readonly runs?: readonly DagViewRun[] }
    setRuns(result.runs ?? [])
  }
  onMount(() => {
    void refresh()
    const off = rpc.events.on("updated", () => void refresh())
    onCleanup(off)
  })
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text>Iolaus DAG</text>
      <text> </text>
      {runs().length === 0
        ? <text>No active DAG runs</text>
        : runs().map((run) => (
          <box flexDirection="column" marginBottom={1}>
            <text>{statusGlyph(run.status)} {run.name} · gen {run.generation}</text>
            <text>{run.nodes.filter((node) => node.status === "completed" || node.status === "reused" || node.status === "skipped").length}/{run.nodes.length} nodes settled</text>
            {run.nodes.map((node) => (
              <box flexDirection="column">
                <text>  {node.status.padEnd(16)} {node.id}</text>
                {node.status === "waiting_approval" && node.prompt ? <text>    gate: {node.prompt}</text> : null}
              </box>
            ))}
          </box>
        ))}
    </box>
  )
}

export default Plugin.define({
  id: "iolaus.tui",
  setup(context) {
    trace("iolaus.tui.loaded", { host: context.app.version })
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <DagSidebar sessionID={sessionID} client={context.client} />,
    })
    return () => { unregister(); trace("iolaus.tui.closed") }
  },
})
