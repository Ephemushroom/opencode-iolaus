import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createMemo, createSignal } from "solid-js"
import { trace } from "./trace"
import { IOLAUS_DAG_RPC } from "./dag/rpc"
import { dagTarget } from "./tui/data"
import { Progress, openDagDialog } from "./tui/dialog"
import { useDagData, useNow } from "./tui/hooks"
import { createSlotPresence, trackSlotPresence, type SlotPresence } from "./tui/presence"
import { DASHED_BORDER, borderTitle, isActiveRun, kindMark, labelColor, liveGlyph, orderNodes, partitionRuns, runActivity, runClock, runHeadline, settledCount, statusColor, statusGlyph, type DagViewRun } from "./tui/view"

/** One line per node: its status glyph, its title (the id when it has none) and the judge or gate mark. */
function RunNodes(props: { readonly run: DagViewRun; readonly frame: number; readonly context: Context; readonly open: (runID: string, nodeID?: string) => void }) {
  const theme = () => props.context.theme
  return <For each={orderNodes(props.run)}>{(node) => {
    const active = () => node.status === "running" || node.status === "starting" || node.status === "waiting_approval"
    return <box flexDirection="row" onMouseUp={(event) => { if (event.button === 0) props.open(props.run.runID, node.id) }}>
      <text flexShrink={0} fg={statusColor(node.status, theme())}>{`${liveGlyph(node.status, props.frame)} `}</text>
      <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={labelColor(node.status, theme())} attributes={active() ? 1 : 0}>{node.title ?? node.id}</text>
      <Show when={kindMark(node.kind)}>{(mark) => <text flexShrink={0} fg={theme().text.muted}>{` ${mark()}`}</text>}</Show>
    </box>
  }}</For>
}

function DagSidebar(props: { readonly sessionID: string; readonly context: Context; readonly presence: SlotPresence }) {
  const { context } = props
  const theme = () => context.theme
  trackSlotPresence(props.presence, () => props.sessionID, (sessionID, mounted) => trace(mounted ? "iolaus.tui.sidebar.mounted" : "iolaus.tui.sidebar.unmounted", { sessionID }))
  const { state, runs } = useDagData(props, true)
  const now = useNow(200)
  const frame = () => Math.floor(now() / 200)
  const groups = createMemo(() => partitionRuns(runs()))
  // Run frames span the sidebar's inner width, and their status title is drawn only when it fits that width.
  const [inner, setInner] = createSignal(35)
  const open = (runID: string, nodeID?: string) => openDagDialog(context, props.sessionID, runID, nodeID)
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} onSizeChange={function () { setInner(this.width - 2) }}>
      <text fg={theme().text.base} attributes={1}>Iolaus</text>
      <Show when={state().status === "loading"}><text fg={theme().text.muted}>Loading flows...</text></Show>
      <Show when={state().status === "error"}><text fg={theme().text.feedback.error.base}>Flows unavailable: {state().error}</text></Show>
      <Show when={state().status === "ready" && runs().length === 0}><text fg={theme().text.muted}>No active flows</text></Show>
      <For each={groups().active}>{(run) => <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}
        border customBorderChars={DASHED_BORDER} borderColor={statusColor(run.status, theme())}
        title={borderTitle(liveGlyph(run.status, frame()), runHeadline(run, now()), inner())} titleColor={statusColor(run.status, theme())}>
        <text wrapMode="none" truncate fg={theme().text.base} attributes={1} onMouseUp={(event) => { if (event.button === 0) open(run.runID) }}>{run.name}</text>
        <Progress run={run} context={context} />
        <RunNodes run={run} frame={frame()} context={context} open={open} />
      </box>}</For>
      <Show when={groups().finished.length > 0}><text marginTop={1} fg={theme().text.muted}>Recent</text></Show>
      <For each={groups().finished}>{(run) => <box flexDirection="column" onMouseUp={(event) => { if (event.button === 0) open(run.runID) }}>
        <text wrapMode="none" truncate fg={statusColor(run.status, theme())}>{statusGlyph(run.status)} {run.name}</text>
        <text wrapMode="none" truncate fg={theme().text.muted}>{"  "}{settledCount(run)}/{run.nodes.length} · {runClock(run, now())}</text>
      </box>}</For>
      <Show when={groups().hidden > 0}><text fg={theme().text.muted}>+{groups().hidden} older (details: {context.keymap.shortcuts("iolaus.dag.show").join(" / ")})</text></Show>
      <Show when={runs().length > 0}><text marginTop={1} fg={theme().text.muted}>Click for details · {context.keymap.shortcuts("iolaus.dag.show").join(" / ")}</text></Show>
    </box>
  )
}

/** Live line above the composer while the sidebar is hidden; the transcript's iolaus_flow row is static while the tool waits. */
function DagComposerStatus(props: { readonly sessionID: string; readonly context: Context; readonly presence: SlotPresence }) {
  const { context } = props
  const theme = () => context.theme
  const { runs } = useDagData(props)
  const now = useNow(200)
  const active = createMemo(() => runs().filter(isActiveRun))
  const shown = createMemo(() => !props.presence.visible(props.sessionID) && active().length > 0)
  return <Show when={shown()}>
    <box flexDirection="column" paddingLeft={2} paddingRight={2}>
      <For each={active()}>{(run) => <text wrapMode="none" truncate fg={statusColor(run.status, theme())}
        onMouseUp={(event) => { if (event.button === 0) openDagDialog(context, props.sessionID, run.runID) }}>
        {liveGlyph(run.status, Math.floor(now() / 200))} Flow {run.name} · {settledCount(run)}/{run.nodes.length} · {runActivity(run)} · {runClock(run, now())}
      </text>}</For>
    </box>
  </Show>
}

function DagLauncher(props: { readonly context: Context }) {
  const { context } = props
  const rpc = context.client.rpc(IOLAUS_DAG_RPC)
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{ id: "iolaus.dag.show", title: "Iolaus Flow: show details", group: "Iolaus", bind: "<leader>d", palette: true,
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
          else context.ui.toast.show({ variant: "info", title: "Iolaus Flow", message: "No flows in this session" })
        } catch (error) {
          context.ui.toast.show({ variant: "error", title: "Iolaus Flow", message: error instanceof Error ? error.message : String(error) })
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
    const presence = createSlotPresence()
    const unregisterLauncher = context.ui.slot({ append: "app", render: () => <DagLauncher context={context} /> })
    const unregisterSidebar = context.ui.slot({ append: "sidebar.content", render: (props) => <DagSidebar sessionID={props.sessionID} context={context} presence={presence} /> })
    const unregisterStatus = context.ui.slot({ append: "session.composer.top", render: (props) => <DagComposerStatus sessionID={props.sessionID} context={context} presence={presence} /> })
    return () => { unregisterLauncher(); unregisterSidebar(); unregisterStatus(); trace("iolaus.tui.closed") }
  },
})
