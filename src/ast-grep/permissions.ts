export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** Mirrors the host's rule glob: `*` spans any characters, `?` one, and a trailing ` *` also matches nothing. */
export function wildcardMatch(value: string, pattern: string): boolean {
  let source = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, "s").test(value.replaceAll("\\", "/"))
}

/** Last matching rule wins; no match resolves to `ask`, as in the host evaluator. */
export function evaluate(action: string, resource: string, rules: readonly PermissionRule[]): PermissionRule["effect"] {
  return rules.findLast((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))?.effect ?? "ask"
}

/**
 * Plugin tools cannot raise an interactive permission request, so only an explicit
 * `allow` passes. `ask` is reported as a denial that names the native tool to use.
 */
export function blockedResources(action: string, resources: readonly string[], rules: readonly PermissionRule[]): string[] {
  return resources.filter((resource) => evaluate(action, resource, rules) !== "allow")
}
