# Remove the Iolaus memory tools

## WHAT WAS TESTED

- `src/home-memory.ts` deleted; the `memory` Code Mode namespace, the
  `memory` permission grant and the `agent/memory` directory are gone. The
  `<iolaus-home>` contract now says cross-session memory is the host's (or the
  user's memory plugin's) concern. Skills loading (PR #25) is kept.
- `bun test` 78 pass, typecheck, build, check:reference, check:package.
- Real OpenCode 2.0.16 isolated QA, 27 checks: every enabled scenario now
  asserts no `agent/memory` is provisioned; `home-skill` asserts the sandbox
  skill is registered and no `memory` namespace appears in Code Mode.

## WHY

The user already runs claude-mem for cross-session memory. A second store
inside Iolaus would split notes across two systems with no reader of both.
