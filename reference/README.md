# Offline OMO reference

This directory preserves 800 source files from commit `598cb66580bebaf39c5ea20ee4bef6cb7a906777` of the source checkout identified in `manifest.json`.

`omo/packages/omo-opencode2/` includes the complete tracked OpenCode2 adapter: custom task/Executor, Team, workflow, continuation, Hashline, configuration, installers, and QA drivers. Its relevant core packages and the original agent/mode prompt packages are retained alongside it for future design reference.

This is a source reference, not a runnable distribution. Some historical imports, scripts, and links point outside the retained subset. Historical development instructions have been renamed `AGENTS.reference.md`. Do not install its package manifests, run its old launchers against your user profile, or add it to a workspace glob.

Run `node script/check-reference.mjs` from the repository root to verify every byte against the recorded hashes. The manifest is the complete retained-file inventory; it has no update command and never fetches upstream.

The active plugin and its release payload use an explicit source/file allowlist. Archiving these features does not enable them in Iolaus.
