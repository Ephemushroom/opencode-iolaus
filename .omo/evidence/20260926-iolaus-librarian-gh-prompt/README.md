# Librarian prompt: gh/git shell references → tools.gh.*

## WHAT WAS TESTED

- `src/omo/agents/specialists/librarian-prompt.ts`: every `gh repo clone`,
  `gh search issues/prs/code`, `gh api …`, `gh issue/pr view`, `git
  rev-parse/log/blame/show` reference rewritten as the matching
  `tools.gh.*` call inside execute (clone → `path`; SHA via
  `tools.gh.log({count: 1})`; tag via `clone({ref})`; releases via
  `tools.gh.repo().data.latestRelease`; PR files via `prDiff`). A "No shell"
  bullet explains the fallback (grep_app + webfetch) when `gh` is absent from
  the catalog. Temp-directory section now says the tool chooses the path.
  Lineage hash refreshed in `reference/active-manifest.json`.
- New unit test asserts the built prompt has no shell-form gh/git commands
  and names each gh tool. `bun test` 66 pass, typecheck, build,
  `check:reference`, `check:package`.
- Real OpenCode 2.0.16 isolated QA (26 checks) re-run unchanged:
  `.omo/evidence/20260926-iolaus-librarian-gh-prompt/`.

## WHAT WAS OBSERVED

- All 26 checks passed. In `gh-librarian` the librarian's rendered system
  prompt contains `tools.gh.clone` and no `gh repo clone`; the live
  repo → clone → log round trip still succeeds; `gh-explore` still cannot see
  or call gh; `gh-off` registers nothing.

## WHY IT IS ENOUGH

The prompt change is text; the test pins the absence of shell forms and the
presence of every tool name, and the live run shows the rendered prompt the
model actually receives. Tool behaviour was proven in PR #18.

## KNOWN LIMITS

- The prompt's earlier "Deep Code Search" via gh is now `tools.gh.searchCode`,
  which inherits GitHub code search's literal-only, rate-limited nature; the
  prompt says to prefer grep_app for regex or bursts.
