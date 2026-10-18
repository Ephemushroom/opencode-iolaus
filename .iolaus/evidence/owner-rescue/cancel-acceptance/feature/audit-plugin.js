import { Plugin } from '@opencode/plugin/effect';
import { Effect, Stream } from 'effect';
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync("/Users/Bryan/.local/share/opencode/worktree/c1d0b7/flow-owner-rescue/.iolaus/evidence/owner-rescue/cancel-acceptance/feature/plugin-inbox.ndjson", JSON.stringify(value) + '\n');
export default Plugin.define({ id: 'rescue-inbox-audit', effect: ctx => Effect.gen(function* () {
  record({ type: 'loaded', inbox: Object.keys(ctx.session.inbox ?? {}), version: ctx.app.version });
  yield* ctx.session.hook('title', event => Effect.sync(() => { event.result = 'QA title'; }));
  yield* ctx.session.hook('context', event => event.agent === 'quick' && JSON.stringify(event.messages).includes('QA_CASE:unknown') ? Effect.die(new Error('QA_UNCLASSIFIED_PLUGIN_FAILURE')) : Effect.void);
  yield* Stream.runForEach(ctx.event.subscribe(), event => Effect.gen(function* () {
    if (event.type === 'session.inbox.enqueued' && ctx.session.inbox) {
      const items = yield* ctx.session.inbox.list({ sessionID: event.data.sessionID });
      record({ type: 'inbox', sessionID: event.data.sessionID, items });
    }
  })).pipe(Effect.forkScoped);
}) });
