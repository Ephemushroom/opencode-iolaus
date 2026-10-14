import { Plugin, Rpc } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { z } from "zod";
import { randomUUID } from "node:crypto";
const definition = Rpc.define({ id: "inbox-effect", methods: { read: { input: z.object({ sessionID: z.string() }), output: z.unknown() } }, events: {} });
const encode = (value) => JSON.parse(JSON.stringify(value));
export default Plugin.define({ id: "inbox-effect-probe", effect: (ctx) => Effect.gen(function* () {
  const instance = randomUUID();
  yield* ctx.rpc.register(definition, { read: ({sessionID}) => Effect.gen(function* () {
    const result = yield* ctx.session.inbox.list({sessionID}).pipe(Effect.match({ onSuccess: (items) => ({items: Schema.encodeSync(Schema.Array(SessionInbox.Info))(items)}), onFailure: (error) => ({error: encode(error)}) }));
    return {...result, methods: Object.keys(ctx.session.inbox), pid: process.pid, instance, location: ctx.location.directory};
  }) });
}) });