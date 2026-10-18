import { Plugin, Rpc } from "@opencode/plugin";
import { Effect, Schema } from "effect";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { z } from "zod";
import { randomUUID } from "node:crypto";
const definition = Rpc.define({ id: "inbox-promise", methods: { read: { input: z.object({ sessionID: z.string() }), output: z.unknown() } }, events: {} });
const encode = (value) => JSON.parse(JSON.stringify(value));
export default Plugin.define({ id: "inbox-promise-probe", async setup(ctx) {
  const instance = randomUUID();
  await ctx.rpc.register(definition, { async read({sessionID}) {
    const result = await ctx.session.inbox.list({sessionID}).then((items) => ({items}), (error) => ({error: {message: String(error), tag: error._tag}}));
    return {...result, methods: Object.keys(ctx.session.inbox), pid: process.pid, instance, location: ctx.location.directory};
  } });
} });