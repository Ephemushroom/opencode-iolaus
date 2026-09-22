import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC_ROOT = join(import.meta.dir, "..")

// Matches session dispatch calls across line breaks, since the index.ts
// background-completion site writes `ctx.session` and `.synthetic({` on
// separate lines.
const DISPATCH_PATTERN = /session\s*\.\s*(prompt|promptAsync|synthetic)\s*\(/g

// Multiple observers of the same idle/error edge can inject the same internal
// message into a live parent session. v2 closes that with the shared gate in
// orchestration/session-dispatch-gate.ts, whose single instance is created in
// index.ts and injected into every feature that injects on such an edge.
//
// Being on this allowlist does NOT mean a site is gated. The gate is for N
// observers of ONE edge, and gating a per-item notifier would drop items:
//
// - index.ts: background task completion. NOT gated on purpose. It fires once
//   per task, so two tasks finishing together are two distinct notifications,
//   and a per-session reservation would silently drop the second.
// - hooks/goal/register.ts: goal idle continuation. Gated, and default-off.
//   The only idle injector today.
// - orchestration/child-session.ts: prompts a child session the engine created
//   and owns, not a live parent. NOT gated; no competing observer exists.
//
// Adding a new dispatch site is a deliberate design decision, not a drive-by
// edit. A new site that injects on an idle/error/completion edge into a live
// parent session MUST take the shared gate instance rather than build its own,
// then update this allowlist and state the justification in the commit message.
// The audit matches source text, so a comment containing a dispatch call shape
// will also trip it; keep dispatch references out of comments.
const PINNED_DISPATCH_SITES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // Explicit command invocations are distinct inputs admitted by the native
  // inbox, not competing observers of an idle/error edge. Gating drops inputs.
  "commands/register-builtin-commands.ts": { prompt: 1 },
  "hooks/goal/register.ts": { synthetic: 1 },
  // Todo continuation. The second idle injector, so it is gated and takes the
  // SAME gate instance goal does; two instances would let both inject on one
  // idle edge. Default-off, and bounded by max_consecutive on top of the gate.
  "hooks/todo-continuation/register.ts": { synthetic: 1 },
  // Boulder (start-work) continuation. The third idle injector, same shared
  // gate, same reason. Default-off; re-reads the plan off disk on every idle.
  "hooks/boulder-continuation/register.ts": { synthetic: 1 },
  "orchestration/child-session.ts": { prompt: 1 },
  "orchestration/execution/session-run.ts": { prompt: 1 },
  // BTW side conversations. The plugin creates and owns the side session
  // (session.create + prompt with omo_btw metadata) exactly like the task
  // engine's child sessions: there is no competing observer, and each
  // btw_start / btw_reply is a distinct user-initiated call, never an
  // idle-edge injection. NOT gated for the same reason child-session is not.
  // Delivery of the side answer back to the parent rides the task engine's
  // waiter pump as a TOOL RESULT, not as a session write.
  "features/btw/tools.ts": { prompt: 2 },
  // Reactive model fallback observes an execution failure on a live main
  // session, switches that session to the next configured model, then queues a
  // continuation. It MUST use the one plugin-wide gate because goal/todo/
  // boulder may observe an adjacent terminal edge and otherwise inject too.
  // Child sessions are excluded before this call site is reached.
  "features/model-fallback/register.ts": { synthetic: 2 },
  // Monitor output delivery. NOT gated, for the same reason as background
  // completion: it fires once per BATCH, from a specific monitor. Two monitors
  // flushing in the same tick are two distinct notifications, and a per-session
  // reservation would admit one and silently drop the other, losing output the
  // user asked to watch. Duplicate suppression is per batch instead, keyed
  // `monitor-output:<id>:batch-<seq>` in features/monitor/delivery.ts, which is
  // the correct granularity here.
  "features/monitor/delivery.ts": { synthetic: 1 },
  // Native monitor dispatch checks managed ownership before its root-only fallback.
  "tools/monitor/register.ts": { synthetic: 1 },
  // Standalone native idle ports are used by legacy-compatible registration tests;
  // production injectors receive the shared execution-aware delivery callback.
  "orchestration/idle-injector.ts": { synthetic: 1 },
  // Per-item root delivery preserves its stable ID; managed recipients instead
  // enqueue an Executor message generation. Observed-edge callers retain their gate.
  "plugin/execution-delivery.ts": { synthetic: 1 },
  // Team member bootstrap. The adapter creates and owns each child session,
  // then submits its initial assignment once. This is not an observed edge and
  // has no competing writer, so it remains outside the shared parent gate.
  "features/team-mode/member-runtime.ts": { prompt: 1 },
  // Team mailbox has two deliberately different writes. Lead-to-member direct
  // delivery is one queued synthetic per explicit message to a plugin-owned
  // child and is ungated. Member-idle wake observes a live edge and injects an
  // unread summary into the lead, so that path takes the one shared gate from
  // index.ts before calling synthetic.
  "features/team-mode/mailbox.ts": { synthetic: 2 },
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      files.push(full)
    }
  }
  return files
}

type DispatchSiteMap = Record<string, Record<string, number>>

function collectDispatchSites(files: string[]): DispatchSiteMap {
  const sites: DispatchSiteMap = {}
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const rel = relative(SRC_ROOT, file).replaceAll("\\", "/")
    for (const match of text.matchAll(DISPATCH_PATTERN)) {
      sites[rel] ??= {}
      const method = match[1]
      sites[rel][method] = (sites[rel][method] ?? 0) + 1
    }
  }
  return sites
}

describe("session dispatch audit", () => {
  test("#given the v2 adapter source #when session dispatch call sites are collected #then they match the pinned allowlist exactly", () => {
    // given
    const files = collectSourceFiles(SRC_ROOT)

    // when
    const sites = collectDispatchSites(files)

    // then
    expect(sites).toEqual(PINNED_DISPATCH_SITES)
  })
})
