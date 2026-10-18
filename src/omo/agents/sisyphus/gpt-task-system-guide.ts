import { buildIolausFlowSection } from "../iolaus-flow-section"

/**
 * The retained GPT task guide. It used to describe `task_create` / `todowrite`,
 * neither of which this harness registers, and a continuation hook that never
 * fires. Multi-part work is tracked by a flow; the exported name stays so the
 * GPT variants keep their call sites.
 */
export function buildTaskSystemGuide(_useTaskSystem: boolean): string {
  return buildIolausFlowSection()
}
