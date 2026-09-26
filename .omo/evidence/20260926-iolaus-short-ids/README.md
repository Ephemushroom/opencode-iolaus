# Short agent ids, title-cased names, short commands, explore takeover

## WHAT WAS TESTED

- `agentID`/`categoryID` return the bare lane name (`sisyphus`, `oracle`,
  `quick`, `deep-high`). Display name is the title-cased lane (`Sisyphus
  Junior`, `Deep High`). Commands are `/ultrawork`, `/hyperplan`, `/team`; the
  `/iolaus-*` forms are no longer recognised.
- `explore` collides with the host's own agent (registered by the host plugin
  `opencode.agent`). Iolaus takes it over: rules reset, Iolaus model/prompt/
  read-only rules applied, trace `iolaus.agent.replaced`. Any other id that
  already exists (user-owned or another plugin's) is still left alone.
- All hard-coded ids in templates, native-bindings, DAG tool text, tests and
  QA scripts renamed; lineage hashes refreshed for the two OMO-derived prompt
  files that mentioned the prefix.
- `bun test` 78 pass, typecheck, build, check:reference, check:package.
- Real OpenCode 2.0.16 isolated QA, 26 checks:
  `.omo/evidence/20260926-iolaus-short-ids/`. Every enabled scenario asserts
  the display names (`Sisyphus`, `Deep High`, `Explore`) and the
  `iolaus.agent.replaced` trace.
- Real TUI in tmux (`.omo/evidence/20260926-iolaus-short-ids-tui/`): Shift+Tab
  cycles `Plan → Sisyphus → Prometheus → Atlas → Build`; the DAG runs through
  the gate and `o` opens the child session as before.

## WHAT WAS OBSERVED

- Host fact: the agent switcher renders the agent *id* title-cased, not the
  `name` field (`iolaus-sisyphus` showed as `Iolaus-Sisyphus`), so the prefix
  can only be removed from the id. Screens `01-agent-footers.txt` show the
  bare names after the change.
- Host fact: the primary cycle contains only `mode: "primary"` agents, so
  Hephaestus (a subagent) is not in it; the QA asserts Prometheus and Atlas.
- Sidebar change made while testing: a gate that has just started waiting is
  auto-selected, so `a`/`r` act on it without the user first pressing `j`/`k`.
- `iolaus.agent.replaced {agent: explore, previous: "Explore"}` in every
  scenario; the explore rules start with `* deny` followed by Iolaus's allows.

## WHY IT IS ENOUGH

Ids are pinned by unit tests and exercised end to end by the live suite (DAG
templates name agents by id; `--agent sisyphus` starts a session). The real
TUI screen proves the user-visible outcome.

## KNOWN LIMITS

- Existing `.iolaus/dag/` runs created with `iolaus-*` ids cannot be retried
  or resumed; new runs are unaffected.
- If oh-my-openagent is ever loaded server-side it registers the same bare
  ids; the first registration wins and Iolaus would skip those agents.
