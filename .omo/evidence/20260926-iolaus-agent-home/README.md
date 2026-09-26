# Iolaus agent home

## WHAT WAS TESTED

- `src/home.ts`: `resolveHome` (user layer `IOLAUS_HOME` default `~/.iolaus`
  with `agent/{plans,memory,skills}`; project layer `<project>/.iolaus` with
  `plans/`, `dag/`), `provisionHome` (idempotent, never overwrites, writes a
  README once), `homeContract` (appended after the native contract in every
  rendered prompt).
- `loadModelsConfig` reads the user layer's `models.json` before the project
  chain; `loadVerifyConfig` falls back to the user layer's `verify.json`.
- `bun test` 69 pass (3 new), typecheck, build, check:reference, check:package.
- Real OpenCode 2.0.16 isolated QA (26 checks) with new assertions in every
  enabled scenario: `.omo/evidence/20260926-iolaus-agent-home/`.

## WHAT WAS OBSERVED

- All 26 checks passed. `iolaus.home.ready` reports `user` under the sandbox
  HOME (`…/home/.iolaus`) and `project` under the fixture project; the three
  `agent/*` dirs and `project/.iolaus/plans` exist after the run; every prompt
  carrying `<iolaus-native-contract>` also carries `<iolaus-home>User layer
  …/home/.iolaus`. The real `~/.iolaus` was not created by QA (sandbox HOME).
- Unit tests: nine directories/files created on first provision, zero on the
  second, a user-edited README preserved; user-layer models override order
  (project > user) and verify fallback (project > user).

## WHY IT IS ENOUGH

Path resolution and precedence are pinned by unit tests; the live run proves
provisioning happens where the host's HOME says and that the contract reaches
the model. No behaviour of existing features changed.

## KNOWN LIMITS

- `agent/memory` and `agent/skills` are provisioned and named in the prompt but
  no Iolaus component reads them yet (skills discovery stays with the host).
