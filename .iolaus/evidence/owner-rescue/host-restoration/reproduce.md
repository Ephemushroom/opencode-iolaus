# Restored Fixture Paths

The stable checkout and its realpath are:

`/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27`

The unchanged approved launcher is:

`/Users/Bryan/.local/share/opencode/worktree/c1d0b7/flow-owner-rescue/.iolaus/evidence/owner-rescue/upstream-inbox/patched-opencode.sh`

The checkout remains detached at the official tag. No branch, commit, temporary
alias, installed-host replacement, or service registration is created.

## Required Pins

| Artifact | Pin |
| --- | --- |
| Official repository | `https://github.com/anomalyco/opencode.git` |
| Tag | `v2.0.27` |
| HEAD | `1f4d07a4a519185955ae8ab2ea3607805509e386` |
| Recorded/restored patch SHA-256 | `23d1153ad3e025058362d7af9ca0d5ef8af6182f219daba877b62caf224911d0` |
| `bun.lock` SHA-256 | `97b04a1407c4cf48ad4e3fc7c0c85932188e4d0e97ca8005309420062887f60f` |
| Launcher SHA-256 | `a713826aedc3e7c114c32d3ac5085f9d2fd9fb42b898d6b2e4402968151fbf8b` |
| Tool versions | Bun `1.4.3`, Node `v24.20.0` |

## Commands Executed During Restoration

Exact arguments, working directories, environment isolation, exit codes, and logs
are recorded in `clone-command.json`, `patch-commands.json`,
`install-command.json`, and the verification `*-command.json` files.

```sh
git clone --depth 1 --branch v2.0.27 --single-branch \
  https://github.com/anomalyco/opencode.git \
  /Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27
```

From that checkout, the archived patch was checked with `git apply --check`, then
applied with `git apply` without rewriting or regenerating it. The five-file
tracked diff plus `git diff --no-index -- /dev/null
packages/core/test/plugin/session-inbox.test.ts` reconstruct the recorded patch
byte-for-byte. `git apply --reverse --check` also confirms its applied state.

`bun install --frozen-lockfile` ran from the checkout with clean, temporary
`HOME`, `USERPROFILE`, `TMPDIR`, all four `XDG_*` state directories, `IOLAUS_HOME`,
and `BUN_INSTALL_CACHE_DIR`. `HUSKY=0` disabled hook installation. The install
sandbox was removed; dependencies remain only in the owned checkout. No lockfile
or package pins were updated.

## Run Fresh Inbox Contract QA

From the Iolaus worktree, choose an unused output directory. Do not rerun the
historical `checks.py` or `lifecycle.py` in place: they write into historical
evidence. The existing probe supports a safe output override:

```sh
QA_OPENCODE_SOURCE=/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27 \
QA_EVIDENCE_DIR="$PWD/.iolaus/evidence/owner-rescue/host-restoration/live-next" \
  node .iolaus/evidence/owner-rescue/upstream-inbox/probe.mjs
```

The probe launches only `patched-opencode.sh serve --hostname 127.0.0.1 --port 0`
in its marked private sandbox, using clean `HOME`/XDG/`IOLAUS_HOME`. It handles
authentication, local mock-provider setup, and process/sandbox cleanup. The
launcher also permits isolated `--version` and `--help`; the source host correctly
identifies itself as `opencode vlocal`, not a relabeled release binary.

## Downstream Feature QA

After the parallel Iolaus fixes and rebuild are ready, the existing feature driver
can use this fixture without editing historical evidence or the driver:

```sh
QA_OPENCODE_SOURCE=/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27 \
QA_HOST_MODE=patched \
  node script/qa-owner-rescue-feature.mjs \
  .iolaus/evidence/owner-rescue/feature-after-host-restoration
```

Use a fresh output path. Feature QA is outside this restoration task and is not
claimed by the host-fixture results.
