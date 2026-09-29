import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { trace } from "../trace"
import { useDagData, useNow } from "./hooks"
import { paneHeights, revealScroll } from "./layout"
import { liveGlyph, nodeResultText, progressBar, runClock, settledCount, statusColor, statusLabel, topologyNodes, waves } from "./view"

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
  const layers = createMemo(() => { const value = run(); return value ? waves(value) : [] })
  const downstream = (id: string) => nodes().filter((node) => node.dependsOn.includes(id)).map((node) => node.id)
  const [selected, setSelected] = createSignal(props.nodeID)
  const current = createMemo(() => nodes().find((node) => node.id === selected()))
  const [busy, setBusy] = createSignal<string>()
  const [focused, setFocused] = createSignal(false)
  const [width, setWidth] = createSignal(0)
  const [height, setHeight] = createSignal(context.renderer.height)
  const [graphContent, setGraphContent] = createSignal(6)
  const [detailContent, setDetailContent] = createSignal(10)
  const now = useNow(200)
  const frame = () => Math.floor(now() / 200)
  let panel: BoxRenderable | undefined
  let list: ScrollBoxRenderable | undefined
  let detail: ScrollBoxRenderable | undefined
  let alive = true
  const cardWidth = () => Math.min(width() || 30, width() < 90 ? 26 : 30)
  const panes = createMemo(() => paneHeights(height() - 13, graphContent(), detailContent()))
  const close = () => context.ui.dialog.clear()

  createEffect(on(nodes, (items) => {
    if (items.some((node) => node.id === selected())) return
    setSelected((items.find((node) => node.status === "waiting_approval") ?? items.find((node) => node.status === "running" || node.status === "starting") ?? items[0])?.id)
  }))
  // Card positions are only refreshed by the renderer's layout pass inside a frame, and a resize re-wraps the cards
  // over several frames (pane height, then measured width, then card width), so no timer can know when the geometry
  // is final. The renderer emits "frame" after that pass; its root Yoga node is dirty there exactly when the pass
  // changed a size that an effect answered, so the reveal keeps following frames until the root is clean and the
  // selected card is in view. The offset is computed here because scrollChildIntoView leaves a card that is exactly
  // as tall as the viewport where it is.
  let revealing = false
  function reveal() {
    const id = selected(), box = list
    if (!id || !box) return false
    const card = box.content.findDescendantById(`dag-dialog-node-${id}`)
    if (!card) return false
    const before = box.scrollTop
    box.scrollTop = revealScroll(before, card.y - box.viewport.y, card.height, box.viewport.height)
    return box.scrollTop !== before
  }
  function stopReveal() {
    if (!revealing) return
    revealing = false
    context.renderer.off("frame", onFrame)
  }
  function onFrame() {
    try {
      if (reveal() || context.renderer.root.getLayoutNode().isDirty()) return
    } catch (error) {
      trace("iolaus.tui.dialog.reveal.failed", { error: String(error) })
    }
    stopReveal()
  }
  function startReveal() {
    if (!revealing) {
      revealing = true
      context.renderer.on("frame", onFrame)
    }
    context.renderer.requestRender()
  }
  createEffect(on([selected, width, height, graphContent, detailContent], startReveal))
  onCleanup(stopReveal)
  createEffect(on(selected, () => detail?.scrollTo(0)))
  onMount(() => {
    context.ui.dialog.set({ size: "xlarge", centered: true })
    panel?.focus()
    const resize = () => setHeight(context.renderer.height)
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
        <text fg={theme().text.base} attributes={1}>DAG details <span>· {props.runID.slice(0, 8)}</span></text>
        <text fg={theme().text.muted} onMouseUp={(event) => { if (event.button === 0) close() }}>Esc close</text>
      </box>
      <Show when={state().status === "loading"}><text fg={theme().text.muted}>Loading DAG...</text></Show>
      <Show when={state().status === "error"}><text fg={theme().text.feedback.error.base}>{state().error}</text></Show>
      <Show when={state().status === "ready" && !run()}><text fg={theme().text.muted}>This DAG is no longer available.</text></Show>
      <Show when={run()}>{(value) => <>
        <text fg={statusColor(value().status, theme())} attributes={1}>{liveGlyph(value().status, frame())} {value().name}</text>
        <text fg={theme().text.muted}>{statusLabel(value().status)} · Done {settledCount(value())}/{value().nodes.length} {progressBar(settledCount(value()), value().nodes.length).split("]")[0]}] · gen {value().generation} · {runClock(value(), now())}</text>
        <box flexDirection="column" height={panes().graph + panes().detail + 1} flexShrink={0} marginTop={1} gap={1}>
          <scrollbox ref={(value) => { list = value }} width="100%" height={panes().graph} flexShrink={0} scrollX={false} contentOptions={{ flexDirection: "column" }}>
            <box width="100%" flexDirection="column" flexShrink={0} onSizeChange={function () { setWidth(this.width); setGraphContent(this.height) }}>
            <For each={layers()}>{(wave, index) => <box id={`dag-dialog-wave-${index()}`} flexDirection="column" alignItems="center">
              <Show when={index() > 0}><text fg={theme().text.muted}>│</text><text fg={theme().text.muted}>▼</text></Show>
              <box width="100%" flexDirection="row" flexWrap="wrap" justifyContent="center" gap={1}>
                <For each={wave}>{(node) => {
                  const chosen = () => selected() === node.id
                  const live = () => node.status === "running" || node.status === "starting"
                  return <box id={`dag-dialog-node-${node.id}`} width={cardWidth()} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}
                    border borderStyle={chosen() ? "heavy" : "rounded"}
                    borderColor={chosen() ? theme().text.action.primary.base : live() ? statusColor(node.status, theme()) : theme().border.base}
                    onMouseDown={(event) => { if (event.button === 0) setSelected(node.id) }}>
                    <text wrapMode="none" truncate fg={chosen() ? theme().text.action.primary.base : theme().text.base} attributes={chosen() ? 1 : 0}>
                      {chosen() ? "›" : " "} {node.id}{node.kind === "judge" ? " ⚖" : node.kind === "gate" ? " ⏸" : ""}
                    </text>
                    <text wrapMode="none" truncate fg={statusColor(node.status, theme())}>{liveGlyph(node.status, frame())} {statusLabel(node.status)}{node.attempt > 1 ? ` · attempt ${node.attempt}` : ""}</text>
                    <text wrapMode="none" truncate fg={theme().text.muted}>{node.title ?? (node.dependsOn.length ? `← ${node.dependsOn.join(", ")}` : "Start node")}</text>
                  </box>
                }}</For>
              </box>
              <Show when={wave.length > 1}><text fg={theme().text.muted}>· {wave.length} in parallel</text></Show>
            </box>}</For>
            </box>
          </scrollbox>
          <scrollbox ref={(value) => { detail = value }} width="100%" height={panes().detail} flexShrink={0} scrollX={false} contentOptions={{ flexDirection: "column" }}>
            <Show when={current()}>{(node) => <box width="100%" flexDirection="column" flexShrink={0} onSizeChange={function () { setDetailContent(this.height) }} border borderStyle="rounded" borderColor={theme().text.action.primary.base} paddingLeft={1} paddingRight={1}
              title={" Node details "} titleColor={theme().text.action.primary.base}>
              <text fg={statusColor(node().status, theme())} attributes={1}>{liveGlyph(node().status, frame())} {node().id}{node().title ? ` · ${node().title}` : ""}</text>
              <text fg={statusColor(node().status, theme())}>Status: {statusLabel(node().status)} · {node().kind}</text>
              <text fg={theme().text.base}>Agent: {node().agent || "human"} · Model: {node().model || "none"} · Attempt: {node().attempt}</text>
              <text fg={theme().text.base}>Depends on: {node().dependsOn.join(", ") || "none (start node)"}</text>
              <text fg={theme().text.base}>Unblocks: {downstream(node().id).join(", ") || "none (final node)"}</text>
              <Show when={node().prompt}><text marginTop={1} fg={theme().text.action.primary.base}>Approval request</text><text fg={theme().text.base}>{node().prompt}</text></Show>
              <Show when={node().error}><text marginTop={1} fg={theme().text.feedback.error.base}>Error</text><text fg={theme().text.base}>{node().error}</text></Show>
              <Show when={node().result}>{(result) => <><text marginTop={1} fg={theme().text.muted}>Result</text><text fg={theme().text.base}>{nodeResultText(result())}</text></>}</Show>
              <Show when={!node().result && !node().error && !node().prompt}><text marginTop={1} fg={theme().text.muted}>No result yet.</text></Show>
              <Show when={retryable()}><text marginTop={1} fg={theme().text.action.primary.base} onMouseUp={(event) => { if (event.button === 0) void decide("retry") }}>[Retry node]</text></Show>
              <Show when={cancellable()}><text fg={theme().text.feedback.error.base} onMouseUp={(event) => { if (event.button === 0) void decide("cancel") }}>[Cancel run]</text></Show>
            </box>}</Show>
          </scrollbox>
        </box>
        <text marginTop={1} fg={theme().text.muted}>{busy() ? `${busy()}...` : `↑/↓ j/k select · ${hasSession() ? "Enter/o open · " : ""}${waiting() ? "a approve · r reject · " : ""}PgUp/PgDn details · Esc close`}</text>
      </>}</Show>
    </box>
  )
}
