import { canonicalJson } from "./canonical-json"
import { DagValidationError } from "./graph-error"
import type { DagCondition, JsonValue } from "./types"

export type ConditionSource = ReadonlyMap<string, JsonValue | null>

export function selectField(payload: JsonValue | null, field?: string): JsonValue | null {
  if (field === undefined || field === "") return payload
  let current: JsonValue | null = payload
  for (const key of field.split(".")) {
    if (current === null || typeof current !== "object") return null
    current = Array.isArray(current) ? (current[Number(key)] ?? null) : (current[key] ?? null)
  }
  return current
}

function asText(value: JsonValue | null): string {
  return typeof value === "string" ? value : value === null ? "" : canonicalJson(value)
}

export function evaluateCondition(condition: DagCondition, source: ConditionSource): boolean {
  if ("all" in condition) return condition.all.every((entry) => evaluateCondition(entry, source))
  if ("any" in condition) return condition.any.some((entry) => evaluateCondition(entry, source))
  if ("not" in condition) return !evaluateCondition(condition.not, source)
  const value = selectField(source.get(condition.node) ?? null, condition.field)
  if (condition.exists !== undefined && (value !== null) !== condition.exists) return false
  if (condition.equals !== undefined && canonicalJson(value) !== canonicalJson(condition.equals)) return false
  if (condition.includes !== undefined && !asText(value).includes(condition.includes)) return false
  if (condition.matches !== undefined && !new RegExp(condition.matches).test(asText(value))) return false
  return true
}

export function validateCondition(condition: DagCondition, nodeID: string, dependsOn: ReadonlySet<string>): void {
  if ("all" in condition) { if (condition.all.length === 0) throw new DagValidationError(`Empty "all" condition: ${nodeID}`); condition.all.forEach((entry) => validateCondition(entry, nodeID, dependsOn)); return }
  if ("any" in condition) { if (condition.any.length === 0) throw new DagValidationError(`Empty "any" condition: ${nodeID}`); condition.any.forEach((entry) => validateCondition(entry, nodeID, dependsOn)); return }
  if ("not" in condition) { validateCondition(condition.not, nodeID, dependsOn); return }
  if (!dependsOn.has(condition.node)) throw new DagValidationError(`Condition on ${nodeID} references non-dependency: ${condition.node}`)
  if (condition.equals === undefined && condition.includes === undefined && condition.matches === undefined && condition.exists === undefined) {
    throw new DagValidationError(`Condition on ${nodeID} has no predicate for node: ${condition.node}`)
  }
  if (condition.matches !== undefined) {
    try { new RegExp(condition.matches) } catch { throw new DagValidationError(`Invalid condition regex on ${nodeID}: ${condition.matches}`) }
  }
}
