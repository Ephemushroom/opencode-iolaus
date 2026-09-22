import { appendFileSync } from "node:fs"

export function trace(event: string, data: Record<string, unknown> = {}): void {
  const path = process.env.IOLAUS_TRACE
  if (path) appendFileSync(path, `${JSON.stringify({ event, ...data })}\n`)
}
