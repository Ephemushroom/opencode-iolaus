function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, normalize(object[key])]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}
