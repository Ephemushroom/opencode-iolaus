import { Effect } from "effect"
import type { DagController } from "./controller"
import type { DagDefinition, DagNodeRecord, DagRunRecord, DagSnapshot } from "./types"

/** Promise view of a DagController for tests, QA scripts and non-Effect callers. Errors reject with the typed error instance. */
export interface DagControllerPromise {
  readonly create: (definition: DagDefinition, ownerSessionID: string) => Promise<DagRunRecord>
  readonly list: (ownerSessionID?: string) => Promise<readonly DagRunRecord[]>
  readonly snapshot: (runID: string, ownerSessionID: string) => Promise<DagSnapshot>
  readonly node: (runID: string, ownerSessionID: string, nodeID: string) => Promise<DagNodeRecord>
  readonly wait: (runID: string, ownerSessionID: string) => Promise<DagRunRecord>
  readonly cancel: (runID: string, ownerSessionID: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly retry: (runID: string, ownerSessionID: string, nodeID?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly resume: (runID: string, ownerSessionID: string) => Promise<DagRunRecord>
  readonly approve: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly reject: (runID: string, ownerSessionID: string, nodeID: string, note?: string, expectedGeneration?: number) => Promise<DagRunRecord>
  readonly amend: (runID: string, ownerSessionID: string, definition: DagDefinition) => Promise<DagRunRecord>
  readonly close: () => void
}

export function promiseController(controller: DagController): DagControllerPromise {
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
  return {
    create: (d, o) => run(controller.create(d, o)),
    list: (o) => run(controller.list(o)),
    snapshot: (r, o) => run(controller.snapshot(r, o)),
    node: (r, o, n) => run(controller.node(r, o, n)),
    wait: (r, o) => run(controller.wait(r, o)),
    cancel: (r, o, g) => run(controller.cancel(r, o, g)),
    retry: (r, o, n, g) => run(controller.retry(r, o, n, g)),
    resume: (r, o) => run(controller.resume(r, o)),
    approve: (r, o, n, note, g) => run(controller.approve(r, o, n, note, g)),
    reject: (r, o, n, note, g) => run(controller.reject(r, o, n, note, g)),
    amend: (r, o, d) => run(controller.amend(r, o, d)),
    close: () => Effect.runSync(controller.close),
  }
}
