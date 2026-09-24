import { Rpc } from "@opencode/plugin"
import { z } from "zod"

const id = z.string().min(1).max(256)
const session = z.object({ sessionID: id }).strict()
const node = z.object({
  id, status: z.string(), agent: z.string(), model: z.string(), attempt: z.number(),
  dependsOn: z.array(z.string()), error: z.string().optional(),
  sessionID: z.string().optional(), result: z.string().optional(),
})
export const DagViewSchema = z.object({
  runs: z.array(z.object({
    runID: id, name: z.string(), generation: z.number(), status: z.string(),
    updatedAt: z.number(), nodes: z.array(node),
  })),
})
export type DagView = z.infer<typeof DagViewSchema>

export const IOLAUS_DAG_RPC = Rpc.define({
  id: "iolaus-dag",
  methods: {
    snapshot: { input: session, output: DagViewSchema },
    action: {
      input: session.extend({
        action: z.enum(["cancel", "retry"]), runID: id,
        generation: z.number().int().positive(), nodeID: id.optional(),
      }).strict(),
      output: DagViewSchema,
      errors: { rejected: z.object({ reason: z.string() }) },
    },
  },
  events: {
    updated: { schema: z.object({ sessionID: id, runID: id, sequence: z.number().int(), type: z.string() }) },
  },
})
