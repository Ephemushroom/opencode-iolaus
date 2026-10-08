import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { SyntaxStyle, type BoxRenderable, type ColorInput, type ScrollBoxRenderable, type ThemeTokenStyle } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { trace } from "../trace"
import { useDagData, useNow } from "./hooks"
import { paneHeights, revealScroll } from "./layout"
import { borderTitle, connector, kindMark, liveGlyph, nodeResult, progressBar, resultLabel, rowStart, runHeadline, settledCount, statusColor, statusLabel, topologyNodes, waves, type DagViewNode, type DagViewRun } from "./view"

export function openDagDialog(context: Context, sessionID: string, runID: string, nodeID?: string) {
  trace("iolaus.tui.dialog.open", { sessionID, runID, nodeID })
  context.ui.dialog.show(() => <DagDialog sessionID={sessionID} runID={runID} nodeID={nodeID} />)
}

/** `━━━━━━━━━━━━ 4/8`: the settled part of the bar in the success colour, the rest in the border colour. */
export function Progress(props: { readonly run: DagViewRun; readonly context: Context }) {
  const theme = () => props.context.theme
  const bar = () => progressBar(settledCount(props.run), props.run.nodes.length)
  // An empty text still takes a cell, so a bar with nothing done (or nothing left) drops that part.
  return <box flexDirection="row">
    <Show when={bar().done}><text flexShrink={0} fg={theme().text.feedback.success.base}>{bar().done}</text></Show>
    <Show when={bar().rest}><text flexShrink={0} fg={theme().border.base}>{bar().rest}</text></Show>
    <text flexShrink={1} wrapMode="none" truncate fg={theme().text.muted}>{` ${bar().count}${props.run.generation > 1 ? ` · gen ${props.run.generation}` : ""}`}</text>
  </box>
}

/** The Markdown scopes of the host's own chat, and the syntax scopes of fenced code, taken from the active theme. */
function markdownStyle(theme: Context["theme"]): SyntaxStyle {
  const scope = (names: string[], foreground: ColorInput, extra: Omit<ThemeTokenStyle["style"], "foreground"> = {}): ThemeTokenStyle => ({ scope: names, style: { foreground, ...extra } })
  const { markdown, syntax } = theme
  return SyntaxStyle.fromTheme([
    scope(["default", "spell", "nospell"], theme.text.base),
    scope(["conceal", "markup.strikethrough", "markup.list.unchecked"], theme.text.muted),
    scope(["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], markdown.heading, { bold: true }),
    scope(["markup.heading.1"], markdown.heading, { bold: true, underline: true }),
    scope(["markup.bold", "markup.strong"], markdown.strong, { bold: true }),
    scope(["markup.italic"], markdown.emphasis, { italic: true }),
    scope(["markup.list"], markdown.listItem),
    scope(["markup.list.checked"], theme.text.feedback.success.base),
    scope(["markup.quote"], markdown.blockQuote, { italic: true }),
    scope(["markup.raw", "markup.raw.block", "markup.raw.inline"], markdown.code),
    scope(["markup.link", "markup.link.url", "string.special.url"], markdown.link, { underline: true }),
    scope(["markup.link.label", "label"], markdown.linkText),
    scope(["comment"], syntax.comment, { italic: true }),
    scope(["string"], syntax.string),
    scope(["number", "boolean", "constant"], syntax.number),
    scope(["keyword"], syntax.keyword, { italic: true }),
    scope(["function", "function.call", "function.method"], syntax.function),
    scope(["variable", "property", "parameter"], syntax.variable),
    scope(["type", "module", "class"], syntax.type),
    scope(["operator", "punctuation.special"], syntax.operator),
    scope(["punctuation", "punctuation.bracket", "punctuation.delimiter"], syntax.punctuation),
  ])
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
  const panes = createMemo(() => paneHeights(height() - 12, graphContent(), detailContent()))
  const close = () => context.ui.dialog.clear()
  // A style may still be drawn by the frame that drops it, so it is freed once the renderer is idle, as the host does.
  const retire = (style: SyntaxStyle) => {
    void context.renderer.idle().then(() => style.destroy(), (error: unknown) => {
      trace("iolaus.tui.markdown.idle.failed", { error: String(error) })
      style.destroy()
    })
  }
  let style: SyntaxStyle | undefined
  const markdown = createMemo(() => {
    if (style) retire(style)
    return (style = markdownStyle(context.theme))
  })
  onCleanup(() => { if (style) retire(style) })
  /** Centre column of each card in a row of `count`, or undefined when the row wraps. */
  const centres = (count: number) => {
    const start = rowStart(count, cardWidth(), width())
    return start === undefined ? undefined : Array.from({ length: count }, (_, i) => start + i * (cardWidth() + 1) + Math.floor((cardWidth() - 1) / 2))
  }
  /** Centre column of a lone card, where a wave that wraps meets the waves around it. */
  const middle = () => centres(1)?.[0] ?? Math.max(0, Math.floor((width() - 1) / 2))
  /** The selected card, what it depends on (↑) and what depends on it (↓). */
  const relation = (node: DagViewNode) => {
    const chosen = current()
    if (!chosen) return " "
    return node.id === chosen.id ? "›" : chosen.dependsOn.includes(node.id) ? "↑" : node.dependsOn.includes(chosen.id) ? "↓" : " "
  }

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
    if (action === "cancel") {
      const confirmed = await context.ui.dialog.confirm({ title: "Cancel flow?", message: `Stop "${value.name}" and interrupt its running agents. Finished nodes keep their results.`, label: { confirm: "Cancel flow", cancel: "Keep running" } })
      // The confirm prompt takes over the dialog slot; bring the details back whatever the answer.
      if (!alive) openDagDialog(context, props.sessionID, props.runID, node.id)
      if (!confirmed) return
      trace("iolaus.tui.cancel.confirmed", { runID: value.runID })
    }
    setBusy(action)
    const destination = target()
    try {
      await rpc.action({ sessionID: destination.sessionID, action, runID: value.runID, generation: value.generation, ...(action === "cancel" ? {} : { nodeID: node.id }) }, { location: { directory: destination.directory } })
      trace("iolaus.tui.action", { action, runID: value.runID, nodeID: node.id })
    } catch (error) {
      context.ui.toast.show({ variant: "error", title: "Iolaus Flow", message: error instanceof Error ? error.message : String(error) })
    } finally { if (alive) { setBusy(undefined); void refresh() } }
  }

  context.keymap.layer(() => ({
    mode: "global",
    target: () => panel,
    enabled: focused(),
    priority: 10,
    commands: [
      { id: "iolaus.dag.down", title: "Iolaus Flow: next node", bind: "j,down", run: () => move(1) },
      { id: "iolaus.dag.up", title: "Iolaus Flow: previous node", bind: "k,up", run: () => move(-1) },
      { id: "iolaus.dag.open", title: "Iolaus Flow: open agent session", bind: "o,return", enabled: hasSession, run: open },
      { id: "iolaus.dag.approve", title: "Iolaus Flow: approve gate", bind: "a", enabled: waiting, run: () => void decide("approve") },
      { id: "iolaus.dag.reject", title: "Iolaus Flow: reject gate", bind: "r", enabled: waiting, run: () => void decide("reject") },
      { id: "iolaus.dag.cancel", title: "Iolaus Flow: cancel flow", bind: "c", enabled: cancellable, run: () => void decide("cancel") },
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
        <box flexDirection="row" flexShrink={1}>
          <text flexShrink={0} fg={theme().text.muted}>{run() ? "Flow · " : "Flow"}</text>
          <text flexShrink={1} wrapMode="none" truncate fg={theme().text.base} attributes={1}>{run()?.name ?? ""}</text>
        </box>
        <box flexDirection="row" flexShrink={0} marginLeft={2} onMouseUp={(event) => { if (event.button === 0) close() }}>
          <text fg={theme().text.base}>esc</text>
          <text fg={theme().text.muted}> close</text>
        </box>
      </box>
      <Show when={state().status === "loading"}><text fg={theme().text.muted}>Loading flow...</text></Show>
      <Show when={state().status === "error"}><text fg={theme().text.feedback.error.base}>{state().error}</text></Show>
      <Show when={state().status === "ready" && !run()}><text fg={theme().text.muted}>This flow is no longer available.</text></Show>
      <Show when={run()}>{(value) => <>
        <box flexDirection="row">
          <text flexShrink={0} fg={statusColor(value().status, theme())}>{`${liveGlyph(value().status, frame())} ${runHeadline(value(), now())}  `}</text>
          <Progress run={value()} context={context} />
        </box>
        <box flexDirection="column" height={panes().graph + panes().detail + 1} flexShrink={0} marginTop={1} gap={1}>
          <scrollbox ref={(value) => { list = value }} width="100%" height={panes().graph} flexShrink={0} scrollX={false} contentOptions={{ flexDirection: "column" }}>
            <box width="100%" flexDirection="column" flexShrink={0} onSizeChange={function () { setWidth(this.width); setGraphContent(this.height) }}>
            <For each={layers()}>{(wave, index) => {
              const start = () => rowStart(wave.length, cardWidth(), width())
              return <box id={`dag-dialog-wave-${index()}`} flexDirection="column">
                <Show when={index() > 0}>
                  <For each={connector(centres(layers()[index() - 1].length), centres(wave.length), middle())}>{(line) => <text wrapMode="none" fg={theme().text.muted}>{line}</text>}</For>
                </Show>
                <box width="100%" flexDirection="row" flexWrap={start() === undefined ? "wrap" : "no-wrap"} justifyContent={start() === undefined ? "center" : "flex-start"} paddingLeft={start() ?? 0} gap={1}>
                  <For each={wave}>{(node) => {
                    const chosen = () => selected() === node.id
                    return <box id={`dag-dialog-node-${node.id}`} width={cardWidth()} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}
                      border borderStyle={chosen() ? "heavy" : "rounded"} borderColor={statusColor(node.status, theme())}
                      title={borderTitle(liveGlyph(node.status, frame()), statusLabel(node.status), cardWidth(), node.attempt)} titleColor={statusColor(node.status, theme())}
                      onMouseDown={(event) => { if (event.button === 0) setSelected(node.id) }}>
                      <box flexDirection="row">
                        <text flexShrink={0} fg={theme().text.action.primary.base} attributes={1}>{`${relation(node)} `}</text>
                        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={chosen() ? theme().text.action.primary.base : theme().text.base} attributes={chosen() ? 1 : 0}>{node.id}</text>
                        <Show when={kindMark(node.kind)}>{(mark) => <text flexShrink={0} fg={theme().text.muted}>{` ${mark()}`}</text>}</Show>
                      </box>
                      <text wrapMode="none" truncate fg={theme().text.muted}>{node.title ?? (node.dependsOn.length ? `← ${node.dependsOn.join(", ")}` : "Start node")}</text>
                    </box>
                  }}</For>
                </box>
                <Show when={start() === undefined && wave.length > 1}><text alignSelf="center" fg={theme().text.muted}>· {wave.length} in parallel</text></Show>
              </box>
            }}</For>
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
              <Show when={node().result}>{(result) => {
                const shown = createMemo(() => nodeResult(result()))
                return <>
                  <text marginTop={1} fg={theme().text.muted}>{resultLabel(node().attempt, node().resultAttempt)}</text>
                  <Show when={shown().markdown} fallback={<text fg={theme().text.base}>{shown().text}</text>}>
                    <markdown content={shown().text} syntaxStyle={markdown()} fg={theme().text.base} tableOptions={{ style: "grid", cellPaddingX: 1 }} />
                  </Show>
                </>
              }}</Show>
              <Show when={!node().result && !node().error && !node().prompt}><text marginTop={1} fg={theme().text.muted}>No result yet.</text></Show>
              <Show when={retryable()}><text marginTop={1} fg={theme().text.action.primary.base} onMouseUp={(event) => { if (event.button === 0) void decide("retry") }}>[Retry node]</text></Show>
            </box>}</Show>
          </scrollbox>
        </box>
        <text marginTop={1} fg={theme().text.muted}>{busy() ? `${busy()}...` : `↑/↓ j/k select · ${hasSession() ? "Enter/o open · " : ""}${waiting() ? "a approve · r reject · " : ""}${cancellable() ? "c cancel flow · " : ""}PgUp/PgDn details · Esc close`}</text>
      </>}</Show>
    </box>
  )
}
