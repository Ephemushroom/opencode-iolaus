import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { IOLAUS_DAG_RPC } from "./dag/rpc"
import { trace } from "./trace"
import { activityLine, depths, elapsed, orderNodes, progressBar, settledCount, statusColor, statusGlyph, summarize, type DagViewNode, type DagViewRun, type ThemeLike } from "./tui/view"

type Selection = { readonly runID: string; readonly nodeID: string } | undefined

/** Latest assistant text per child session, so the sidebar can show what each agent is doing right now. */
function useActivity(context: Context) {
  const [activity, setActivity] = createSignal<Record<string, string>>({})
  const read = (sessionID: string) => {
    const messages = context.data.session.message.list(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as unknown as { role?: string; parts?: readonly { type?: string; text?: string }[] }
      if (message.role !== "assistant") continue
      const text = (message.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join(" ")
      if (text) return text
    }
    return undefined
  }
  const watch = (sessionIDs: readonly string[]) => {
    for (const id of sessionIDs) {
      void context.data.session.message.sync(id).then(() => {
        const line = activityLine(read(id))
        if (line) setActivity((prev) => (prev[id] === line ? prev : { ...prev, [id]: line }))
      }).catch(() => undefined)
    }
  }
  onMount(() => {
    const off = context.data.listen(({ details }) => {
      const sessionID = (details as { properties?: { sessionID?: string; info?: { sessionID?: string } } }).properties?.sessionID
        ?? (details as { properties?: { info?: { sessionID?: string } } }).properties?.info?.sessionID
      if (typeof sessionID === "string") {
        const line = activityLine(read(sessionID))
        if (line) setActivity((prev) => (prev[sessionID] === line ? prev : { ...prev, [sessionID]: line }))
      }
    })
    onCleanup(off)
  })
  return { activity, watch }
}

function DagSidebar(props: { readonly sessionID: string; readonly context: Context }) {
  const { context } = props
  const theme = (context.theme ?? {}) as unknown as ThemeLike
  const rpc = context.client.rpc(IOLAUS_DAG_RPC)
  const [runs, setRuns] = createSignal<readonly DagViewRun[]>([])
  const [selected, setSelected] = createSignal<Selection>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const { activity, watch } = useActivity(context)
  const seenGates = new Set<string>()

  const refresh = async () => {
    const result = await rpc.snapshot({ sessionID: props.sessionID }) as unknown as { readonly runs?: readonly DagViewRun[] }
    const next = result.runs ?? []
    setRuns(next)
    watch(next.flatMap((run) => run.nodes.filter((n) => n.status === "running" && n.sessionID).map((n) => n.sessionID!)))
    // A gate that has just started waiting takes the selection, so `a`/`r` act on it without the user hunting for it.
    const waiting = next.flatMap((r) => r.nodes.filter((n) => n.status === "waiting_approval").map((n) => ({ runID: r.runID, nodeID: n.id, key: `${r.runID}:${n.id}:${n.attempt}` })))
    const fresh = waiting.find((gate) => !seenGates.has(gate.key))
    for (const gate of waiting) seenGates.add(gate.key)
    if (fresh) { setSelected({ runID: fresh.runID, nodeID: fresh.nodeID }); return }
    // Otherwise keep a valid selection: default to the first gate waiting, else the first running node.
    const current = selected()
    const stillThere = current && next.some((r) => r.runID === current.runID && r.nodes.some((n) => n.id === current.nodeID))
    if (!stillThere) {
      const gate = next.flatMap((r) => r.nodes.filter((n) => n.status === "waiting_approval").map((n) => ({ runID: r.runID, nodeID: n.id })))[0]
      const running = next.flatMap((r) => r.nodes.filter((n) => n.status === "running").map((n) => ({ runID: r.runID, nodeID: n.id })))[0]
      setSelected(gate ?? running ?? (next[0]?.nodes[0] ? { runID: next[0].runID, nodeID: next[0].nodes[0].id } : undefined))
    }
  }

  onMount(() => {
    void refresh()
    const off = rpc.events.on("updated", (event) => {
      void refresh()
      const detail = event as unknown as { type?: string; runID?: string }
      if (detail.type === "node.waiting") {
        void context.attention.notify({ title: "Iolaus DAG", message: "A gate is waiting for your decision", notification: "always" as never }).catch(() => undefined)
      }
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => { off(); clearInterval(tick) })
  })

  const flat = createMemo(() => runs().flatMap((run) => orderNodes(run).map((node) => ({ run, node }))))
  const index = createMemo(() => { const s = selected(); return s ? flat().findIndex((e) => e.run.runID === s.runID && e.node.id === s.nodeID) : -1 })
  const move = (delta: number) => {
    const list = flat(); if (!list.length) return
    const next = list[Math.min(list.length - 1, Math.max(0, (index() < 0 ? 0 : index()) + delta))]
    setSelected({ runID: next.run.runID, nodeID: next.node.id })
  }
  const current = () => { const i = index(); return i >= 0 ? flat()[i] : undefined }

  const decide = async (action: "approve" | "reject" | "retry" | "cancel") => {
    const entry = current(); if (!entry) return
    if ((action === "approve" || action === "reject") && entry.node.status !== "waiting_approval") { context.ui.toast.show({ variant: "warning", title: "Iolaus DAG", message: "Selected node is not a waiting gate" }); return }
    setBusy(action)
    try {
      await rpc.action({ sessionID: props.sessionID, action, runID: entry.run.runID, generation: entry.run.generation, ...(action === "cancel" ? {} : { nodeID: entry.node.id }) })
      trace("iolaus.tui.action", { action, runID: entry.run.runID, nodeID: entry.node.id })
      context.ui.toast.show({ variant: "success", title: "Iolaus DAG", message: `${action} · ${entry.node.id}` })
    } catch (error) {
      context.ui.toast.show({ variant: "error", title: "Iolaus DAG", message: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(undefined); void refresh() }
  }
  const open = () => {
    const entry = current(); if (!entry) return
    if (!entry.node.sessionID || entry.node.sessionID.startsWith("judge:")) { context.ui.toast.show({ variant: "info", title: "Iolaus DAG", message: entry.node.kind === "judge" ? "Judge nodes have no session; the verdict is in the node result" : "This node has not started a session yet" }); return }
    trace("iolaus.tui.open", { runID: entry.run.runID, nodeID: entry.node.id, sessionID: entry.node.sessionID })
    if (!context.ui.tabs.enabled() || !context.ui.tabs.focus(entry.node.sessionID)) context.ui.router.navigate({ type: "session", sessionID: entry.node.sessionID })
  }

  context.keymap.layer(() => ({
    enabled: runs().length > 0,
    priority: 10,
    commands: [
      { id: "iolaus.dag.down", title: "Iolaus DAG: next node", group: "Iolaus", bind: "j", run: () => move(1) },
      { id: "iolaus.dag.up", title: "Iolaus DAG: previous node", group: "Iolaus", bind: "k", run: () => move(-1) },
      { id: "iolaus.dag.open", title: "Iolaus DAG: open selected agent session", group: "Iolaus", bind: "o", palette: true, run: () => open() },
      { id: "iolaus.dag.approve", title: "Iolaus DAG: approve selected gate", group: "Iolaus", bind: "a", palette: true, enabled: () => current()?.node.status === "waiting_approval", run: () => void decide("approve") },
      { id: "iolaus.dag.reject", title: "Iolaus DAG: reject selected gate", group: "Iolaus", bind: "r", palette: true, enabled: () => current()?.node.status === "waiting_approval", run: () => void decide("reject") },
      { id: "iolaus.dag.retry", title: "Iolaus DAG: retry selected node", group: "Iolaus", palette: true, enabled: () => ["failed", "needs_retry", "interrupted"].includes(current()?.node.status ?? ""), run: () => void decide("retry") },
      { id: "iolaus.dag.cancel", title: "Iolaus DAG: cancel selected run", group: "Iolaus", palette: true, enabled: () => current()?.run.status === "running" || current()?.run.status === "paused", run: () => void decide("cancel") },
    ],
  }))

  const nodeRow = (run: DagViewRun, node: DagViewNode, depth: number) => {
    const isSelected = () => { const s = selected(); return !!s && s.runID === run.runID && s.nodeID === node.id }
    const color = statusColor(node.status, theme)
    const line = () => `${isSelected() ? "›" : " "} ${"  ".repeat(depth)}${statusGlyph(node.status)} ${node.id}${node.kind === "judge" ? " ⚖" : node.kind === "gate" ? " ⏸" : ""}${node.attempt > 1 ? ` ×${node.attempt}` : ""}`
    const detail = () => node.status === "waiting_approval" && node.prompt ? `gate: ${node.prompt}`
      : (node.status === "running" && node.sessionID && activity()[node.sessionID]) ? activity()[node.sessionID]
      : node.error ? node.error.slice(0, 80)
      : undefined
    return (
      <box flexDirection="column" onMouseDown={() => { setSelected({ runID: run.runID, nodeID: node.id }); }} onMouseUp={() => { if (isSelected()) open() }}>
        <text fg={color} attributes={isSelected() ? 1 : 0}>{line()}</text>
        <Show when={detail()}>{(d) => <text fg={node.status === "waiting_approval" ? theme.accent : theme.textMuted}>{"    "}{"  ".repeat(depth)}{d()}</text>}</Show>
      </box>
    )
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={theme.primary} attributes={1}>Iolaus DAG</text>
      <Show when={runs().length === 0}><text fg={theme.textMuted}>No active DAG runs</text></Show>
      <For each={runs()}>{(run) => {
        const depthMap = depths(run)
        return (
          <box flexDirection="column" marginTop={1}>
            <text fg={statusColor(run.status, theme)}>{statusGlyph(run.status)} {run.name.length > 40 ? `${run.name.slice(0, 39)}…` : run.name}</text>
            <text fg={theme.textMuted}>{progressBar(settledCount(run), run.nodes.length)} · gen {run.generation} · {elapsed(run.updatedAt, now())} ago</text>
            <For each={orderNodes(run)}>{(node) => nodeRow(run, node, depthMap.get(node.id) ?? 0)}</For>
          </box>
        )
      }}</For>
      <Show when={runs().length > 0}>
        <text fg={theme.textMuted}> </text>
        <text fg={theme.textMuted}>{busy() ? `${busy()}…` : "j/k select · o open agent · a approve · r reject"}</text>
      </Show>
    </box>
  )
}

function DagFooter(props: { readonly sessionID: string; readonly context: Context }) {
  const theme = (props.context.theme ?? {}) as unknown as ThemeLike
  const rpc = props.context.client.rpc(IOLAUS_DAG_RPC)
  const [runs, setRuns] = createSignal<readonly DagViewRun[]>([])
  const refresh = async () => {
    const result = await rpc.snapshot({ sessionID: props.sessionID }) as unknown as { readonly runs?: readonly DagViewRun[] }
    setRuns(result.runs ?? [])
  }
  onMount(() => { void refresh(); const off = rpc.events.on("updated", () => void refresh()); onCleanup(off) })
  const summary = createMemo(() => summarize(runs()))
  return <text fg={summary().waiting ? theme.accent : summary().failed ? theme.error : theme.textMuted}>{summary().text}</text>
}

export default Plugin.define({
  id: "iolaus.tui",
  setup(context) {
    trace("iolaus.tui.loaded", { host: context.app.version })
    const unregisterSidebar = context.ui.slot({ append: "sidebar.content", render: ({ sessionID }) => <DagSidebar sessionID={sessionID} context={context} /> })
    const unregisterFooter = context.ui.slot({ append: "sidebar.footer", render: ({ sessionID }) => <DagFooter sessionID={sessionID} context={context} /> })
    return () => { unregisterSidebar(); unregisterFooter(); trace("iolaus.tui.closed") }
  },
})
