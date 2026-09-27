import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { trace } from "../trace"
import { useDagData, useNow } from "./hooks"
import { depths, elapsed, nodeResultText, progressBar, settledCount, statusColor, statusGlyph, topologyNodes } from "./view"

export function openDagDialog(context: Context, sessionID: string, runID: string, nodeID?: string) {
  trace("iolaus.tui.dialog.open", { sessionID, runID, nodeID })
  context.ui.dialog.show(() => <DagDialog sessionID={sessionID} runID={runID} nodeID={nodeID} />)
}

function DagDialog(props: { readonly sessionID: string; readonly runID: string; readonly nodeID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const { rpc, target, state, refresh, runs } = useDagData({ context, sessionID: props.sessionID })
  const run = createMemo(() => runs().find((run) => run.runID === props.runID))
  const nodes = createMemo(() => { const value = run(); return value ? topologyNodes(value) : [] })
  const levels = createMemo(() => { const value = run(); return value ? depths(value) : new Map<string, number>() })
  const [selected, setSelected] = createSignal(props.nodeID)
  const current = createMemo(() => nodes().find((node) => node.id === selected()))
  const [busy, setBusy] = createSignal<string>()
  const [focused, setFocused] = createSignal(false)
  const [width, setWidth] = createSignal(context.renderer.width)
  const [height, setHeight] = createSignal(context.renderer.height)
  const now = useNow()
  let panel: BoxRenderable | undefined
  let list: ScrollBoxRenderable | undefined
  let detail: ScrollBoxRenderable | undefined
  let alive = true
  const compact = () => width() < 110
  const bodyHeight = () => Math.max(8, Math.min(30, height() - 12))
  const close = () => context.ui.dialog.clear()

  createEffect(on(nodes, (items) => {
    if (items.some((node) => node.id === selected())) return
    setSelected((items.find((node) => node.status === "waiting_approval") ?? items.find((node) => node.status === "running" || node.status === "starting") ?? items[0])?.id)
  }))
  createEffect(on(selected, (id) => {
    if (id) list?.scrollChildIntoView(`dag-dialog-node-${id}`)
    detail?.scrollTo(0)
  }))
  onMount(() => {
    context.ui.dialog.set({ size: "xlarge", centered: true })
    panel?.focus()
    const resize = () => { setWidth(context.renderer.width); setHeight(context.renderer.height) }
    context.renderer.on("resize", resize)
    onCleanup(() => context.renderer.off("resize", resize))
  })
  onCleanup(() => { alive = false; trace("iolaus.tui.dialog.closed", { sessionID: props.sessionID, runID: props.runID }) })

  const move = (delta: number) => {
    const items = nodes()
    const index = items.findIndex((node) => node.id === selected())
    setSelected(items[Math.min(items.length - 1, Math.max(0, index + delta))]?.id)
  }
  const open = () => {
    const node = current()
    if (!node?.sessionID || node.sessionID.startsWith("judge:")) return
    trace("iolaus.tui.open", { runID: props.runID, nodeID: node.id, sessionID: node.sessionID })
    close()
    if (!context.ui.tabs.enabled() || !context.ui.tabs.focus(node.sessionID)) context.ui.router.navigate({ type: "session", sessionID: node.sessionID })
  }
  const waiting = () => !busy() && current()?.status === "waiting_approval"
  const hasSession = () => !!current()?.sessionID && !current()?.sessionID?.startsWith("judge:")
  const retryable = () => !busy() && ["failed", "needs_retry", "interrupted"].includes(current()?.status ?? "")
  const cancellable = () => !busy() && (run()?.status === "running" || run()?.status === "paused")
  const decide = async (action: "approve" | "reject" | "retry" | "cancel") => {
    const node = current(), value = run()
    if (!node || !value || busy()) return
    if ((action === "approve" || action === "reject") && !waiting()) return
    if ((action === "retry" && !retryable()) || (action === "cancel" && !cancellable())) return
    setBusy(action)
    const destination = target()
    try {
      await rpc.action({ sessionID: destination.sessionID, action, runID: value.runID, generation: value.generation, ...(action === "cancel" ? {} : { nodeID: node.id }) }, { location: { directory: destination.directory } })
      trace("iolaus.tui.action", { action, runID: value.runID, nodeID: node.id })
    } catch (error) {
      context.ui.toast.show({ variant: "error", title: "Iolaus DAG", message: error instanceof Error ? error.message : String(error) })
    } finally { if (alive) { setBusy(undefined); void refresh() } }
  }

  context.keymap.layer(() => ({
    mode: "global",
    target: () => panel,
    enabled: focused(),
    priority: 10,
    commands: [
      { id: "iolaus.dag.down", title: "Iolaus DAG: next node", bind: "j,down", run: () => move(1) },
      { id: "iolaus.dag.up", title: "Iolaus DAG: previous node", bind: "k,up", run: () => move(-1) },
      { id: "iolaus.dag.open", title: "Iolaus DAG: open agent session", bind: "o,return", enabled: hasSession, run: open },
      { id: "iolaus.dag.approve", title: "Iolaus DAG: approve gate", bind: "a", enabled: waiting, run: () => void decide("approve") },
      { id: "iolaus.dag.reject", title: "Iolaus DAG: reject gate", bind: "r", enabled: waiting, run: () => void decide("reject") },
      { bind: "pageup", run: () => detail?.scrollBy(-Math.max(1, detail.viewport.height - 1)) },
      { bind: "pagedown", run: () => detail?.scrollBy(Math.max(1, detail.viewport.height - 1)) },
      { bind: "escape", run: close },
    ],
  }))

  return (
    <box ref={(value) => { panel = value }} focusable flexDirection="column" padding={1}
      on:focused={() => setFocused(true)} on:blurred={() => setFocused(false)}
      onMouseDown={(event) => { if (event.button === 0) { panel?.focus(); event.preventDefault() } }}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={1}>DAG details</text>
        <text fg={theme().text.muted} onMouseUp={(event) => { if (event.button === 0) close() }}>Esc close</text>
      </box>
      <Show when={state().status === "loading"}><text fg={theme().text.muted}>Loading DAG...</text></Show>
      <Show when={state().status === "error"}><text fg={theme().text.feedback.error.base}>{state().error}</text></Show>
      <Show when={state().status === "ready" && !run()}><text fg={theme().text.muted}>This DAG is no longer available.</text></Show>
      <Show when={run()}>{(value) => <>
        <text fg={statusColor(value().status, theme())}>{statusGlyph(value().status)} {value().name}</text>
        <text fg={theme().text.muted}>{progressBar(settledCount(value()), value().nodes.length)} · {value().status} · gen {value().generation} · updated {elapsed(value().updatedAt, now())} ago</text>
        <box flexDirection={compact() ? "column" : "row"} height={bodyHeight()} marginTop={1} gap={2}>
          <scrollbox ref={(value) => { list = value }} width={compact() ? "100%" : "40%"} height={compact() ? "40%" : "100%"} scrollX={false} contentOptions={{ flexDirection: "column" }}>
            <text fg={theme().text.muted}>NODES · dependency order</text>
            <For each={nodes()}>{(node) => <box id={`dag-dialog-node-${node.id}`} flexDirection="column"
              backgroundColor={selected() === node.id ? theme().background.action.primary.state({ selected: true }) : undefined}
              onMouseDown={(event) => { if (event.button === 0) setSelected(node.id) }}>
              <text fg={selected() === node.id ? theme().text.action.primary.state({ selected: true }) : statusColor(node.status, theme())} attributes={selected() === node.id ? 1 : 0}>
                {selected() === node.id ? "›" : " "} {"  ".repeat(Math.min(levels().get(node.id) ?? 0, 4))}{statusGlyph(node.status)} {node.id}
              </text>
            </box>}</For>
          </scrollbox>
          <scrollbox ref={(value) => { detail = value }} flexGrow={1} height={compact() ? "60%" : "100%"} scrollX={false} contentOptions={{ flexDirection: "column", paddingRight: 1 }}>
            <Show when={current()}>{(node) => <>
              <text fg={theme().text.base} attributes={1}>{node().id}</text>
              <text fg={statusColor(node().status, theme())}>Status: {node().status} · {node().kind}</text>
              <text fg={theme().text.base}>Agent: {node().agent || "human"}</text>
              <text fg={theme().text.base}>Model: {node().model || "none"}</text>
              <text fg={theme().text.base}>Attempt: {node().attempt}</text>
              <text fg={theme().text.base}>Depends on: {node().dependsOn.join(", ") || "none (root)"}</text>
              <Show when={node().prompt}><text marginTop={1} fg={theme().text.action.primary.base}>Approval request</text><text fg={theme().text.base}>{node().prompt}</text></Show>
              <Show when={node().error}><text marginTop={1} fg={theme().text.feedback.error.base}>Error</text><text fg={theme().text.base}>{node().error}</text></Show>
              <Show when={node().result}>{(result) => <><text marginTop={1} fg={theme().text.muted}>Result · snapshot excerpt</text><text fg={theme().text.base}>{nodeResultText(result())}</text></>}</Show>
              <Show when={!node().result && !node().error && !node().prompt}><text marginTop={1} fg={theme().text.muted}>No result yet.</text></Show>
              <Show when={retryable()}><text marginTop={1} fg={theme().text.action.primary.base} onMouseUp={(event) => { if (event.button === 0) void decide("retry") }}>[Retry node]</text></Show>
              <Show when={cancellable()}><text fg={theme().text.feedback.error.base} onMouseUp={(event) => { if (event.button === 0) void decide("cancel") }}>[Cancel run]</text></Show>
            </>}</Show>
          </scrollbox>
        </box>
        <text marginTop={1} fg={theme().text.muted}>{busy() ? `${busy()}...` : `↑/↓ j/k select · ${hasSession() ? "Enter/o open · " : ""}${waiting() ? "a approve · r reject · " : ""}PgUp/PgDn details · Esc close`}</text>
      </>}</Show>
    </box>
  )
}
