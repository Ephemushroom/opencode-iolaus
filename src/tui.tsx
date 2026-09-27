import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createMemo } from "solid-js"
import { trace } from "./trace"
import { IOLAUS_DAG_RPC } from "./dag/rpc"
import { dagTarget } from "./tui/data"
import { openDagDialog } from "./tui/dialog"
import { useDagData, useNow } from "./tui/hooks"
import { elapsed, orderNodes, progressBar, settledCount, statusColor, statusGlyph, summarize } from "./tui/view"

function DagSidebar(props: { readonly sessionID: string; readonly context: Context }) {
  const { context } = props
  const theme = () => context.theme
  const { state, runs } = useDagData(props, true)
  const now = useNow()
  const open = (runID: string, nodeID?: string) => openDagDialog(context, props.sessionID, runID, nodeID)
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={theme().text.base} attributes={1}>Iolaus DAG</text>
      <Show when={state().status === "loading"}><text fg={theme().text.muted}>Loading DAG runs...</text></Show>
      <Show when={state().status === "error"}><text fg={theme().text.feedback.error.base}>DAG unavailable: {state().error}</text></Show>
      <Show when={state().status === "ready" && runs().length === 0}><text fg={theme().text.muted}>No active DAG runs</text></Show>
      <For each={runs()}>{(run) => <box flexDirection="column" marginTop={1}>
        <text fg={statusColor(run.status, theme())} onMouseUp={(event) => { if (event.button === 0) open(run.runID) }}>{statusGlyph(run.status)} {run.name.length > 40 ? `${run.name.slice(0, 39)}…` : run.name}</text>
        <text fg={theme().text.muted}>{progressBar(settledCount(run), run.nodes.length)} · gen {run.generation} · {elapsed(run.updatedAt, now())} ago</text>
        <Show when={run.nodes.some((node) => node.status === "waiting_approval")}><text fg={theme().text.action.primary.base}>{run.nodes.filter((node) => node.status === "waiting_approval").length} awaiting approval</text></Show>
        <For each={orderNodes(run)}>{(node) => <text fg={statusColor(node.status, theme())} onMouseUp={(event) => { if (event.button === 0) open(run.runID, node.id) }}>
          {"  "}{statusGlyph(node.status)} {node.id}{node.kind === "judge" ? " ⚖" : node.kind === "gate" ? " ⏸" : ""}
        </text>}</For>
      </box>}</For>
      <Show when={runs().length > 0}><text marginTop={1} fg={theme().text.muted}>Click DAG/node for details · {context.keymap.shortcuts("iolaus.dag.show").join(" / ")}</text></Show>
    </box>
  )
}

function DagFooter(props: { readonly sessionID: string; readonly context: Context }) {
  const theme = () => props.context.theme
  const { runs, state } = useDagData(props)
  const summary = createMemo(() => summarize(runs()))
  return <text fg={state().status === "error" || summary().failed ? theme().text.feedback.error.base : summary().waiting ? theme().text.action.primary.base : theme().text.muted}>{state().status === "loading" ? "DAG · loading" : state().status === "error" ? "DAG · unavailable" : summary().text}</text>
}

function DagLauncher(props: { readonly context: Context }) {
  const { context } = props
  const rpc = context.client.rpc(IOLAUS_DAG_RPC)
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{ id: "iolaus.dag.show", title: "Iolaus DAG: show details", group: "Iolaus", bind: "<leader>d", palette: true,
      enabled: () => context.ui.router.current().type === "session",
      run: async () => {
        const route = context.ui.router.current()
        if (route.type !== "session") return
        const target = dagTarget(context, route.sessionID)
        try {
          const view = await rpc.snapshot({ sessionID: target.sessionID }, { location: { directory: target.directory } })
          const active = context.ui.router.current()
          if (active.type !== "session" || active.sessionID !== target.sessionID) return
          if (view.runs[0]) openDagDialog(context, target.sessionID, view.runs[0].runID)
          else context.ui.toast.show({ variant: "info", title: "Iolaus DAG", message: "No DAG runs in this session" })
        } catch (error) {
          context.ui.toast.show({ variant: "error", title: "Iolaus DAG", message: error instanceof Error ? error.message : String(error) })
        }
      },
    }],
  }))
  return null
}

export default Plugin.define({
  id: "iolaus.tui",
  setup(context) {
    trace("iolaus.tui.loaded", { host: context.app.version })
    const unregisterLauncher = context.ui.slot({ append: "app", render: () => <DagLauncher context={context} /> })
    const unregisterSidebar = context.ui.slot({ append: "sidebar.content", render: (props) => <DagSidebar sessionID={props.sessionID} context={context} /> })
    const unregisterFooter = context.ui.slot({ append: "sidebar.footer", render: (props) => <DagFooter sessionID={props.sessionID} context={context} /> })
    return () => { unregisterLauncher(); unregisterSidebar(); unregisterFooter(); trace("iolaus.tui.closed") }
  },
})
