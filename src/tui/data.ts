import type { DagView } from "../dag/rpc"

export interface DagTarget {
  readonly sessionID: string
  readonly directory: string
}

export type DagState = {
  readonly status: "loading" | "ready" | "error"
  readonly runs: DagView["runs"]
  readonly error?: string
}

type Location = { readonly directory: string }
interface TargetContext {
  readonly location?: Location
  readonly data: {
    readonly session: { get(sessionID: string): { readonly location: Location } | undefined }
    readonly location: { default(): Location }
  }
}

export function dagTarget(context: TargetContext, sessionID: string): DagTarget {
  const directory = context.data.session.get(sessionID)?.location.directory
    ?? context.location?.directory ?? context.data.location.default().directory
  return { sessionID, directory }
}

export function matchesDagEvent(target: DagTarget, event: {
  readonly data: { readonly sessionID: string }
  readonly location?: { readonly directory?: string }
}): boolean {
  return event.data.sessionID === target.sessionID && event.location?.directory === target.directory
}

/** Discard replies from superseded requests, including after a slot is disposed. */
export function createDagQuery(
  snapshot: (input: { sessionID: string }, options: { location: { directory: string } }) => Promise<DagView>,
  publish: (state: DagState) => void,
) {
  let revision = 0
  let previous: DagTarget | undefined
  return {
    async refresh(target: DagTarget): Promise<void> {
      const request = ++revision
      if (previous?.sessionID !== target.sessionID || previous.directory !== target.directory) {
        publish({ status: "loading", runs: [] })
      }
      previous = target
      try {
        const view = await snapshot({ sessionID: target.sessionID }, { location: { directory: target.directory } })
        if (request === revision) publish({ status: "ready", runs: view.runs })
      } catch (error) {
        if (request === revision) publish({ status: "error", runs: [], error: error instanceof Error ? error.message : String(error) })
      }
    },
    dispose() { revision += 1 },
  }
}
