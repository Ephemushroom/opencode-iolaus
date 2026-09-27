import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { IOLAUS_DAG_RPC } from "../dag/rpc"
import { trace } from "../trace"
import { createDagQuery, dagTarget, matchesDagEvent, type DagState } from "./data"

export function useDagData(props: { readonly sessionID: string; readonly context: Context }, notify = false) {
  const { context } = props
  const rpc = context.client.rpc(IOLAUS_DAG_RPC)
  const target = createMemo(() => dagTarget(context, props.sessionID))
  const [state, setState] = createSignal<DagState>({ status: "loading", runs: [] })
  const query = createDagQuery((input, options) => rpc.snapshot(input, options), setState)
  const refresh = () => query.refresh(target())
  createEffect(on(target, () => { void refresh() }))
  onCleanup(() => query.dispose())
  onMount(() => {
    const off = rpc.events.on("updated", (event) => {
      if (!matchesDagEvent(target(), event)) return
      void refresh()
      if (notify && event.data.type === "node.waiting") {
        void context.attention.notify({ title: "Iolaus DAG", message: "A gate is waiting for your decision", notification: { when: "always" } })
          .catch((error) => trace("iolaus.tui.notification.failed", { error: String(error) }))
      }
    })
    onCleanup(off)
  })
  return { rpc, target, state, refresh, runs: () => state().runs }
}

export function useNow() {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(tick))
  })
  return now
}
