# Remove Iolaus skills loading and agent/plans

## WHAT WAS TESTED

- `src/home-skills.ts` deleted with its tests; `agent/skills`, `agent/plans`
  and the `agent/` directory are no longer resolved, provisioned or granted.
  `IolausHome` is now `user`, `project`, `projectPlans`, `projectDag`. The
  `<iolaus-home>` contract names the two config layers and says skills and
  memory come from the host and its plugins.
- `bun test` 76 pass, typecheck, build, check:reference, check:package.
- Real OpenCode 2.0.16 isolated QA, 26 checks: every enabled scenario asserts
  the user layer has its README and no `agent/` directory, and the rendered
  prompt carries the new contract.

## WHY

The host already discovers skills globally and from `~/.agent/skills`; a
third location owned by Iolaus would only split them. `agent/plans` existed
for Prometheus outside a project, which does not happen in practice.
