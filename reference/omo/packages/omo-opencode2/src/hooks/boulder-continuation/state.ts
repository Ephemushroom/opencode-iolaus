import { getActiveWorks, getPlanChecklist, getWorkForSession, readBoulderState, resolveBoulderPlanPathForWork } from "@oh-my-opencode/boulder-state"
import type { BoulderWorkState, PlanChecklist } from "@oh-my-opencode/boulder-state"

const CONTINUABLE_STATUSES = new Set(["active", "paused"])

export type BoulderContinuationState = {
  readonly planName: string
  readonly planPath: string
  readonly checklist: PlanChecklist
  // "session" when the work's session_ids contain this session (a resumed
  // session); "sole-active" when the file holds exactly one active work, which
  // v2 treats as the session's plan since nothing else binds them.
  readonly boundVia: "session" | "sole-active"
}

/**
 * Reads the active boulder work for a session off disk and reports the plan
 * progress that remains. Returns null when there is nothing to continue: no
 * boulder file, no continuable work, or the plan is already fully checked off.
 *
 * v2 keeps the whole association in the file and re-reads it on every idle, so
 * the enforcer holds no in-memory boulder state and the same state survives a
 * restart. A session is considered to own work when either its id is recorded
 * in the work (an exact resume match) or, in v2's single-active-work mode, the
 * file holds one active work and this is the only plan to continue.
 */
export function readBoulderContinuationState(directory: string, sessionID: string): BoulderContinuationState | null {
  if (readBoulderState(directory) === null) return null

  let work: BoulderWorkState | null = getWorkForSession(directory, sessionID)
  let boundVia: BoulderContinuationState["boundVia"] = "session"

  if (work === null) {
    const active = getActiveWorks(directory).filter((candidate) => CONTINUABLE_STATUSES.has(candidate.status ?? "active"))
    if (active.length !== 1) return null
    work = active[0]
    boundVia = "sole-active"
  }

  if (!CONTINUABLE_STATUSES.has(work.status ?? "active")) return null

  const planPath = resolveBoulderPlanPathForWork(directory, work)
  const checklist = getPlanChecklist(planPath)
  if (checklist.remaining === 0) return null

  return { planName: work.plan_name, planPath, checklist, boundVia }
}
