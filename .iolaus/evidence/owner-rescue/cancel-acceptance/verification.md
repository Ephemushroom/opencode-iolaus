# Cancellation Fix Acceptance

**VERIFICATION: PASS**

- Fresh run: `2026-10-14T07:45:09.511406+00:00` to `2026-10-14T07:46:11.964839+00:00`; Bun `1.4.3`, Node `v24.20.0`.
- Current Git HEAD: `9ad51bb76f1ada0b6059ab8c37c324a7ad7ddc45`. This is the current dirty worktree, not HEAD alone; all **215 active source/config/test fingerprints** remained unchanged.
- **19/19 commands returned their expected exits**. `bun test`: **475 passed, 0 failed, 2,800 assertions, 22 files**.
- Patched host: **52 feature checks** (previous 49 plus three cancellation cases); steering: **35 checks**. Typecheck, fresh build/package (100 active manifest files), reference (800 files), five syntax checks and whitespace check passed.
- Stock 2.0.27 default-off: **3 checks, PASS/0**; stock opt-in: **2 checks, expected UNSUPPORTED/2**. Historical host-contract probe: **5 checks, expected BLOCKED/2**, not positive rescue proof.
- Six negative cleanup cases passed: four historical cases plus partial setup and failed spawn (the latter two intentionally return FAIL/1). No QA driver or application changes were needed.

## Invocation And Exit Ledger

The fresh audit wrapper reused the historical audit method without changing historical evidence:

```sh
python3 .iolaus/evidence/owner-rescue/cancel-acceptance-audit/run.py
```

It executed the requested verifier with the source override and no archive/binary/fault/mode override:

```sh
QA_OPENCODE_SOURCE=/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27 node script/qa-owner-rescue-verify.mjs .iolaus/evidence/owner-rescue/cancel-acceptance
```

Exact absolute argv, environment controls, timings and expected/actual exits are in [commands.json](commands.json); the actual wrapper argv is in [command.json](../cancel-acceptance-audit/command.json). The table abbreviates these two exact paths:

```sh
E=/Users/Bryan/.local/share/opencode/worktree/c1d0b7/flow-owner-rescue/.iolaus/evidence/owner-rescue/cancel-acceptance
T=/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/rescue-verification-x8614O
```

| Executed Command | Expected / Actual |
| --- | --- |
| `curl --fail --location https://opencode.ai/files/bin/2.0.27/opencode-darwin-arm64.zip --output $T/stock.zip` | 0 / 0 |
| `node --check script/qa-owner-rescue-feature.mjs` | 0 / 0 |
| `node --check script/qa-owner-rescue-verify.mjs` | 0 / 0 |
| `node --check script/qa-owner-rescue.mjs` | 0 / 0 |
| `node --check script/qa-owner-rescue-cleanup.mjs` | 0 / 0 |
| `node --check script/qa-flow-steering.mjs` | 0 / 0 |
| `bun run check:reference` | 0 / 0 |
| `bun run check:package` | 0 / 0 |
| `bun run typecheck` | 0 / 0 |
| `bun test` | 0 / 0 |
| `node script/qa-owner-rescue-cleanup.mjs $E/historical-cleanup` | 0 / 0 |
| `QA_OPENCODE_BIN=$T/opencode QA_HOST_MODE=stock-on node script/qa-owner-rescue-feature.mjs $E/stock-on` | 2 / 2 |
| `QA_OPENCODE_BIN=$T/opencode node script/qa-owner-rescue.mjs $E/historical-blocked-probe` | 2 / 2 |
| `QA_OPENCODE_BIN=$T/opencode QA_HOST_MODE=stock-off node script/qa-owner-rescue-feature.mjs $E/stock-off` | 0 / 0 |
| `QA_OPENCODE_BIN=$T/opencode node script/qa-flow-steering.mjs $E/steering` | 0 / 0 |
| `QA_HOST_MODE=patched node script/qa-owner-rescue-feature.mjs $E/feature` | 0 / 0 |
| `QA_FAULT=partial-setup QA_HOST_MODE=patched node script/qa-owner-rescue-feature.mjs $E/partial-setup` | 1 / 1 |
| `QA_FAULT=spawn QA_HOST_MODE=patched node script/qa-owner-rescue-feature.mjs $E/spawn` | 1 / 1 |
| `git diff --check` | 0 / 0 |

## Cancellation Evidence

- [cancel-fallback.json](feature/cancel-fallback.json) and [cancel-attempt.json](feature/cancel-attempt.json): attempt 2 completed one native write and retained its queued requirement before cancellation. Retry/resume/amend refused immediately, after reload, and after disabling rescue. Both preserved the old checkpoint for audit only, set `cancelled_continuation`, published no late result/rescue, and made **zero additional child-provider requests**. Counts are three requests each: A/B/B for fallback, A/A/A for remaining attempts (second request executes the write, third waits for the late reply).
- [cancel-excluded.json](feature/cancel-excluded.json): initially planning-excluded execution remained unblocked; cancellation, ordinary retry and amended execution produced exactly three allowed A requests.
- The 475-test suite includes the 25 cancellation regressions: native late successful outcomes and downstream fencing, reload with rescue enabled/disabled, cancellation after disabling rescue, late-created references, pre-admission/creation races, excluded/planning roles, fresh default-off controls, and untouched completed/gate/observed history. Fresh default-off cancellation is unit-covered; live default-off covers the ordinary fallback budget.

## Artifact Binding And Isolation

- Patched host source: `/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27`, tag `v2.0.27`, SHA `1f4d07a4a519185955ae8ab2ea3607805509e386`. Exact tracked diff plus added inbox test matched the pinned patch; reverse-apply check passed.
- Patch SHA-256: `23d1153ad3e025058362d7af9ca0d5ef8af6182f219daba877b62caf224911d0`; host lock SHA-256: `97b04a1407c4cf48ad4e3fc7c0c85932188e4d0e97ca8005309420062887f60f`.
- Launcher SHA-256: `a713826aedc3e7c114c32d3ac5085f9d2fd9fb42b898d6b2e4402968151fbf8b`.
- Current `dist/index.js` SHA-256: `effd43ee75d4702ed93ede83b1c0ddcd184b6098c1452a641ef8416fba0c1010`. Fresh build output, feature source receipt, and the sandbox original bundle hash before fault injection match exactly; all three dist bundles also matched before/after.
- Fresh private stock archive SHA-256: `391b1061dc3f1f4394b7fd19513b2e6ff12f31739ee12f33880506ed6ee008bc`; extracted stock 2.0.27 binary: `7fa5c8659e57cae76b1da4f45edbc583aef93aae917246a0b3abb1ac1b3fb93c`. The private download/extraction directory was removed.
- All **17 protected-path fingerprints** were unchanged: real Iolaus/OpenCode configuration, service metadata, installed binary, installed plugin bundles and fixture pin evidence. Installed `/opt/homebrew/Cellar/opencode-v2/2.0.28/bin/opencode` was hashed only, never used or replaced; no production service/API/DB operation was issued.
- Each live host used private HOME/XDG/IOLAUS_HOME and loopback mock providers. Recorded host/descendant DB handles were exclusively sandbox paths. All receipts have empty cleanup errors, removed sandboxes, gone process groups and closed mocks; feature receipts report zero sockets. Independent before/after QA process and sandbox inventories were both empty.
- No commits, pushes, PRs, deployment, patch-pin edits or installed-host/config/service/database writes. Only new evidence and the normal local dist rebuild were written.

## Limits And Audit Files

- Runtime proof is API-driven native OpenCode sessions with local deterministic mock providers, not TUI interaction or remote-provider availability. Stock opt-in UNSUPPORTED and the historical BLOCKED probe remain negative proofs, not rescue compatibility claims. Installed 2.0.28 compatibility was not tested.
- Cancellation cases ran before instrumentation on the unmodified rebuilt plugin. Later race cases use documented deterministic pauses only in sandbox copies; steering lost-ack cases mutate only sandbox receipts. No production DB was opened for audit; isolation uses reviewed environment/commands, point-in-time open-handle inspection and cleanup inventories, not a continuous OS syscall trace. Inbox reads are point-in-time, not atomic transfer or exactly-once guarantees.
- [receipt.json](receipt.json), [independent-results.json](../cancel-acceptance-audit/independent-results.json), [artifact-binding.json](../cancel-acceptance-audit/artifact-binding.json), [before.json](../cancel-acceptance-audit/before.json), [after.json](../cancel-acceptance-audit/after.json), and [summary.json](../cancel-acceptance-audit/summary.json) bind this acceptance to the current source/build and fresh runtime evidence.

**Blockers: none within this acceptance scope.**
