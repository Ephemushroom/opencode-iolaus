import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Trace = (event: string, detail?: Record<string, unknown>) => void

export function createTrace(): Trace {
  const file = process.env.OMO_SPIKE_TRACE
  if (!file) return () => undefined
  mkdirSync(dirname(file), { recursive: true })
  return (event, detail) => appendFileSync(file, `${JSON.stringify({ t: Date.now(), event, ...detail })}\n`)
}
