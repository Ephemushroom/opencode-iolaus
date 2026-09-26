import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import type { IolausHome } from "./home"

export const MEMORY_NAMESPACE = "memory"
export const MEMORY_PERMISSION = "memory"
export const MEMORY_NAMESPACE_DESCRIPTION =
  "Durable notes in the Iolaus agent home (user layer agent/memory, shared across projects; project layer .iolaus/memory, this project only). Keep facts that should survive this session: decisions, non-obvious project conventions, pitfalls. One note per file, markdown, named by a short kebab-case slug. Read before repeating investigation; write when you learn something durable."

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_BYTES = 64 * 1024
const MAX_LIST = 200

type Layer = "user" | "project"
type Payload = { readonly ok: boolean; readonly kind: string } & Record<string, unknown>

function invalid(kind: string, message: string): Payload {
  return { ok: false, kind, error: { code: "INVALID_ARGUMENT", message } }
}

function root(home: IolausHome, layer: Layer): string {
  return layer === "user" ? home.userMemory : join(home.project, "memory")
}

function inside(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function notePath(home: IolausHome, layer: Layer, slug: string): string | undefined {
  if (!SLUG.test(slug)) return undefined
  const dir = root(home, layer)
  const path = resolve(dir, `${slug}.md`)
  return inside(dir, path) ? path : undefined
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 120) ?? ""
}

export function listNotes(home: IolausHome, layer?: Layer): { readonly slug: string; readonly layer: Layer; readonly title: string; readonly bytes: number; readonly updatedAt: number }[] {
  const layers: Layer[] = layer ? [layer] : ["user", "project"]
  const notes = []
  for (const l of layers) {
    const dir = root(home, l)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue
      const slug = entry.slice(0, -3)
      if (!SLUG.test(slug)) continue
      const path = join(dir, entry)
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        notes.push({ slug, layer: l, title: firstLine(readFileSync(path, "utf8")), bytes: stat.size, updatedAt: stat.mtimeMs })
      } catch { continue }
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LIST)
}

export interface MemoryHost {
  readonly home: (sessionID: string) => Promise<IolausHome>
  readonly trace?: (event: string, data: Record<string, unknown>) => void
}

const layerProp = { type: "string", enum: ["user", "project"], description: "user: shared across projects (default for read/list); project: this project only." } as const
const slugProp = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Note name, kebab-case." } as const
const output = { type: "object", properties: { ok: { type: "boolean" }, kind: { type: "string" } }, required: ["ok", "kind"] } as const

/** Read-only tools carry `read` permission; `write`/`remove` carry `memory`, which the registration grants to the primaries and metis. */
export function createMemoryTools(host: MemoryHost): Tool.Info[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: readonly string[], permission: string, run: (input: Record<string, unknown>, home: IolausHome) => Payload): Tool.Info => ({
    name, description,
    input: { type: "object", properties, required: [...required], additionalProperties: false },
    output,
    options: { namespace: MEMORY_NAMESPACE, permission },
    execute: (raw: unknown, context: Tool.Context) => Effect.promise(async () => {
      const input = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
      const home = await host.home(String(context.sessionID))
      const payload = run(input, home)
      host.trace?.("iolaus.memory.call", { tool: name, agent: String(context.agent), ok: payload.ok, layer: input.layer ?? null, slug: input.slug ?? null })
      return { output: payload }
    }),
  } as Tool.Info)

  return [
    tool("list", "List notes, newest first, with layer, title and size.", { layer: layerProp }, [], "read", (input, home) => {
      const layer = input.layer === "user" || input.layer === "project" ? input.layer : undefined
      return { ok: true, kind: "list", notes: listNotes(home, layer) }
    }),
    tool("read", "Read one note. Looks in the project layer first, then the user layer, unless layer is given.", { slug: slugProp, layer: layerProp }, ["slug"], "read", (input, home) => {
      const slug = String(input.slug ?? "")
      const layers: Layer[] = input.layer === "user" || input.layer === "project" ? [input.layer] : ["project", "user"]
      for (const layer of layers) {
        const path = notePath(home, layer, slug)
        if (!path) return invalid("read", "slug must be kebab-case")
        if (existsSync(path)) return { ok: true, kind: "read", slug, layer, text: readFileSync(path, "utf8") }
      }
      return { ok: false, kind: "read", error: { code: "NOT_FOUND", message: `No note named ${slug}` } }
    }),
    tool("write", "Create or replace a note. Default layer is project; use user for facts that apply everywhere.", { slug: slugProp, text: { type: "string", minLength: 1 }, layer: layerProp }, ["slug", "text"], MEMORY_PERMISSION, (input, home) => {
      const slug = String(input.slug ?? ""), text = String(input.text ?? "")
      const layer: Layer = input.layer === "user" ? "user" : "project"
      const path = notePath(home, layer, slug)
      if (!path) return invalid("write", "slug must be kebab-case")
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return invalid("write", `note exceeds ${MAX_BYTES} bytes`)
      mkdirSync(root(home, layer), { recursive: true })
      const existed = existsSync(path)
      writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`)
      return { ok: true, kind: "write", slug, layer, path, replaced: existed }
    }),
    tool("remove", "Delete a note from one layer.", { slug: slugProp, layer: layerProp }, ["slug", "layer"], MEMORY_PERMISSION, (input, home) => {
      const slug = String(input.slug ?? "")
      const layer: Layer = input.layer === "user" ? "user" : "project"
      const path = notePath(home, layer, slug)
      if (!path) return invalid("remove", "slug must be kebab-case")
      if (!existsSync(path)) return { ok: false, kind: "remove", error: { code: "NOT_FOUND", message: `No note named ${slug} in ${layer}` } }
      unlinkSync(path)
      return { ok: true, kind: "remove", slug, layer }
    }),
  ]
}
