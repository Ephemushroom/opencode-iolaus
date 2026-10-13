# Owner Interruption Regression

Date: 2026-10-12

The reviewed P1 was reproduced before the fix with:

```sh
bun test tests/dag-steering.test.ts --test-name-pattern 'owner interruption'
```

Both admission-success and admission-failure cases timed out after interrupting
the caller in the same controller. Releasing the mocked receipt and old child
result did not settle the flow. Cleanup then rejected its stranded waiter.

The fix atomically hands the steering operation to controller scope before the
caller starts its interruptible join. Reservation, dispatch, receipt finalization,
and replacement result tracking no longer depend on the caller's fiber. Controller
shutdown can still interrupt the operation; existing durable reload recovery is
preserved. Uncertain admission still cancels the child and interrupts the node.

Post-fix commands and results:

- `bun test tests/dag-steering.test.ts`: 25 passed, 0 failed.
- `bun test`: 342 passed, 0 failed, 1985 assertions.
- `bun run typecheck`: exit 0.
- `bun run check:package`: build and package checks PASS, 100 active files.
- `bun run check:reference`: PASS, 800 historical files unchanged.
- `node --check script/qa-flow-steering.mjs`: exit 0.
- `git diff --check`: exit 0.
- `node script/qa-flow-steering.mjs .iolaus/evidence/flow-steering-sdk/owner-interruption-final`: PASS, 35 live checks with OpenCode 2.0.27 and a local mock provider.

The live regression interrupts the owner's actual steering tool execution both
before synthetic admission and after host admission but before receipt return.
Each case releases the deterministic pause without reloading the controller and
observes `reserved -> admitted -> delivered`, exactly one supplemental host
message, unchanged child agent/model, and only the new result reaching downstream.
Timing pauses modify only the sandbox plugin copy, not repository source or dist.

`receipt.json` records checks, isolated HOME/XDG/IOLAUS_HOME paths, sandbox-only
database handles, unchanged real-host configuration hashes, and cleanup. The
sandbox directory was removed, its process group exited, and the mock closed.
This is API-based QA, not TUI QA or a host-spanning exactly-once guarantee.

Source/test/documentation changes in this follow-up: `src/dag/controller.ts`,
`tests/dag-steering.test.ts`, `script/qa-flow-steering.mjs`, and `README.md`.
Other pre-existing working-tree changes were preserved.
